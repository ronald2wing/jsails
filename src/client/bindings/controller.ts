/**
 * Browser DOM binding layer ("DOMglue") for stateful server components.
 *
 * This is the DOM half of the component story. The pure controller in
 * `state-decoding.ts` owns the client model, the serialized update queue, and
 * the same-origin/CSRF POST; this module owns everything that touches the
 * document:
 *
 * - It bootstraps one {@link ComponentController} per `[data-jsails-component]`
 *   root, reading the signed snapshot and CSRF markers the server rendered.
 * - It delegates `input`/`change` at the document level and writes native
 *   control values into the controller's working state via `setField`.
 * - It delegates `click[data-jsails-call]` and `submit[data-jsails-submit]`,
 *   collecting the latest bound field values and the element's explicit JSON
 *   args, then dispatching exactly one action. Field values are never folded
 *   into action args.
 * - It morphs the full server root on every render (outer replace, `method`
 *   morph), retargets the controller when the morph replaces the root element,
 *   and reapplies working values without disturbing an unchanged control's
 *   caret.
 * - It shows a fixed plaintext message on a fatal error and never injects raw
 *   response HTML; a 422 validation render is morphed from the server's own
 *   HTML.
 *
 * The bootstrap/manager surface above is backed by three per-concern sibling
 * modules, each re-exported from here so the barrel's public surface is
 * unchanged:
 *
 * - `control-values.ts` — control value read/write/compare plus the
 *   capture/reapply passes (including the file-input skip).
 * - `rules.ts` — rule parsing/evaluation and application to a control
 *   or across a whole root.
 * - `uploads.ts` — the file-upload marker/error/progress glue.
 *
 * Scope rules:
 * - An event is handled only when its target resolves to a component root via
 *   `closest`, so a control outside any root is ignored.
 * - Controls owned by a client island (`[data-jsails-island]`) are excluded:
 *   the island owns its own state and the component must not capture it.
 * - Nested islands inside a morphed root are torn down and remounted through
 *   the shared {@link IslandManager} (`beforeMorph`/`afterMorph`), never a
 *   second manager.
 *
 * This module is browser-safe and Node-import safe: it imports no DOM lib and
 * models the surface it needs with structural types, matching the
 * `islands.ts`/`broadcast/client.ts` convention.
 */

import type { JsonObject } from '../../contracts/http.js';
import {
  ARGS_ATTRIBUTE,
  CALL_ATTRIBUTE,
  COMPONENT_ATTRIBUTE,
  COMPONENT_CSRF_ATTRIBUTE,
  COMPONENT_SNAPSHOT_ATTRIBUTE,
  CONFIRM_ATTRIBUTE,
  DEBOUNCE_ATTRIBUTE,
  DIRTY_ATTRIBUTE,
  IGNORE_ATTRIBUTE,
  INTERSECT_ATTRIBUTE,
  LOADING_ATTRIBUTE,
  LOADING_TARGET_ATTRIBUTE,
  MAX_DEBOUNCE_MS,
  MAX_POLL_MARKER_LENGTH,
  MIN_POLL_INTERVAL_MS,
  MODEL_ATTRIBUTE,
  POLL_ATTRIBUTE,
  REF_ATTRIBUTE,
  SHOW_ATTRIBUTE,
  SORT_ATTRIBUTE,
  SUBMIT_ATTRIBUTE,
  TEXT_ATTRIBUTE,
  type ComponentPollOptions,
} from '../../server-components/protocol.js';
import {
  ComponentControllerError,
  createComponentController,
  type ComponentController,
  type ComponentRender,
  type ComponentUploadFile,
  type ComponentUploadProgress,
} from '../state-decoding.js';
import {
  ISLAND_ATTRIBUTE,
  ISLAND_HYDRATED_ATTRIBUTE,
  type IslandManager,
  type JsailsDocument,
  type JsailsElement,
  type JsailsEvent,
} from '../islands.js';
import {
  MODEL_SELECTOR,
  captureBoundValues,
  isFileInput,
  readControlValue,
  reapplyWorkingValues,
} from './control-values.js';
import { applyFieldValidation, evaluateFieldRules, parseFieldRules, validateAll } from './rules.js';
import { COMPONENT_UPLOAD_FAILED_MESSAGE, findUploadInput, handleFileChange } from './uploads.js';

// ---------------------------------------------------------------------------
// Structural DOM types
// ---------------------------------------------------------------------------

/**
 * The slice of a DOM element the binding layer touches. Declared structurally
 * (no DOM lib) so the module stays Node-importable; a real `HTMLElement`
 * satisfies every member.
 */
export interface ComponentElement extends JsailsElement {
  readonly tagName: string;
  readonly parentElement: ComponentElement | null;
  /** Current value of a form control (`input`/`select`/`textarea`). */
  value?: string;
  /** Checked state of a checkbox/radio. */
  checked?: boolean;
  /** Control type (`text`, `checkbox`, `number`, ...). */
  type?: string;
  /** Whether a `<select>` allows multiple selections. */
  multiple?: boolean;
  /** Selected options of a `<select>`. */
  readonly selectedOptions?: ArrayLike<{ readonly value: string }>;
  /** Selected files of a file input (`input.files`). */
  files?: ArrayLike<ComponentUploadFile>;
  querySelector(selector: string): ComponentElement | null;
  querySelectorAll(selector: string): ArrayLike<ComponentElement>;
  closest(selector: string): ComponentElement | null;
  /** Insert `element` relative to this element (error message placement). */
  insertAdjacentElement(position: string, element: ComponentElement): void;
  /** Remove this element from the document. */
  remove(): void;
  addEventListener(type: string, listener: (event: JsailsEvent) => void, options?: unknown): void;
  removeEventListener(
    type: string,
    listener: (event: JsailsEvent) => void,
    options?: unknown,
  ): void;
  /** Visibility toggle (mirrors `HTMLElement.hidden`). */
  hidden?: boolean;
  /** Move focus to this control (optional; absent on minimal test fakes). */
  focus?(): void;
}

/** The slice of `document` the binding layer touches. */
export interface ComponentDocument extends JsailsDocument {
  querySelector(selector: string): ComponentElement | null;
  getElementById(id: string): ComponentElement | null;
  createElement(tagName: string): ComponentElement;
}

/**
 * Minimal structural contract for an `IntersectionObserverEntry` — the shape
 * the binding layer reads from the observer callback. Declared structurally
 * (no DOM lib) so the module stays Node-importable.
 */
interface IntersectionObserverEntryLike {
  readonly target: ComponentElement;
  readonly isIntersecting: boolean;
}

/**
 * Minimal structural contract for an `IntersectionObserver` — the subset the
 * binding layer uses. A real `IntersectionObserver` satisfies every member.
 */
interface IntersectionObserverLike {
  observe(target: ComponentElement): void;
  unobserve(target: ComponentElement): void;
  disconnect(): void;
}

/** A morph function: render `html` into the element with `target` id. */
type ComponentMorph = (target: string, html: string) => Promise<void>;

/**
 * Signals the poll scheduler consults to pause/resume a root's polling. Read
 * once per binding; the scheduler subscribes to changes to react to visibility
 * and connectivity without re-reading markers after a morph.
 */
export interface PollSignals {
  /** Whether the document is currently hidden (pauses when `pauseWhenHidden`). */
  readonly hidden: boolean;
  /** Whether the browser reports a live connection (pauses when `pauseWhenOffline`). */
  readonly online: boolean;
  /** Subscribe to signal changes; returns an unsubscribe function. */
  onChange(listener: () => void): () => void;
}

/** Signals that never report hidden/offline and never fire changes. */
const NO_POLL_SIGNALS: PollSignals = {
  hidden: false,
  online: true,
  onChange: () => () => {},
};

/**
 * Signals backed by `document.hidden` and `navigator.onLine`, listening to
 * `visibilitychange`/`online`/`offline`. Falls back to {@link NO_POLL_SIGNALS}
 * outside a browser (no `document`/`navigator`).
 */
function defaultPollSignals(): PollSignals {
  const g = globalThis as {
    document?: {
      hidden: boolean;
      addEventListener(type: string, listener: () => void): void;
      removeEventListener(type: string, listener: () => void): void;
    };
    navigator?: { onLine: boolean };
    addEventListener?(type: string, listener: () => void): void;
    removeEventListener?(type: string, listener: () => void): void;
  };
  const documentObject = g.document;
  const navigator = g.navigator;
  if (documentObject === undefined || navigator === undefined) {
    return NO_POLL_SIGNALS;
  }

  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of Array.from(listeners)) {
      listener();
    }
  };

  return {
    get hidden(): boolean {
      return documentObject.hidden;
    },
    get online(): boolean {
      return navigator.onLine;
    },
    onChange(listener: () => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) {
        documentObject.addEventListener('visibilitychange', emit);
        g.addEventListener?.('online', emit);
        g.addEventListener?.('offline', emit);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          documentObject.removeEventListener('visibilitychange', emit);
          g.removeEventListener?.('online', emit);
          g.removeEventListener?.('offline', emit);
        }
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fixed plaintext shown when a component is permanently blocked. */
export const COMPONENT_BLOCKED_MESSAGE =
  'This component could not be updated. Reload the page to try again.';

/** Selector for a component root. */
const ROOT_SELECTOR = `[${COMPONENT_ATTRIBUTE}]`;

/** Selector for a client island (its controls are out of scope). */
const ISLAND_SELECTOR = `[${ISLAND_ATTRIBUTE}]`;

/** Selector for an ignored subtree (its controls are out of scope). */
const IGNORE_SELECTOR = `[${IGNORE_ATTRIBUTE}]`;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised for binding-layer misconfiguration. Messages are value-free. */
export class ComponentBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComponentBindingError';
  }
}

// ---------------------------------------------------------------------------
// Args parsing
// ---------------------------------------------------------------------------

/**
 * Parse an element's explicit `data-jsails-args` JSON. Absent or empty yields
 * an empty object; malformed JSON or a non-object yields `null` so the caller
 * can reject the action without dispatching.
 */
export function parseActionArgs(raw: string | null): JsonObject | null {
  if (raw === null || raw === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as JsonObject;
}

// ---------------------------------------------------------------------------
// Binding manager
// ---------------------------------------------------------------------------

/** Handle returned by the poll scheduler; stopping is idempotent. */
interface PollHandle {
  stop(): void;
}

/** A live binding between one component root and its controller. */
interface RootBinding {
  element: ComponentElement;
  readonly controller: ComponentController;
  /** Upload error elements keyed by the file input they belong to. */
  readonly uploadErrors: WeakMap<ComponentElement, ComponentElement>;
  /** Per-field debounce timers keyed by model field name. */
  readonly debounce: Map<string, ReturnType<typeof setTimeout>>;
  /** Poll scheduler handle, present when the root carries a poll marker. */
  poll: PollHandle | null;
  /** Signals driving poll pause/resume; resolved once at binding creation. */
  readonly signals: PollSignals;
  disposed: boolean;
  /**
   * The intersection observer watching this root's `[data-jsails-intersect]`
   * elements, or `null` when no such elements exist (no needless observer).
   */
  intersectionObserver: IntersectionObserverLike | null;
}

/** Options for {@link createComponentBindings}. */
interface ComponentBindingsOptions {
  readonly document: ComponentDocument;
  /** Morphs server HTML into the root by element id. */
  readonly morph: ComponentMorph;
  /** Shared island manager, used to tear down/remount nested islands. */
  readonly islands?: IslandManager;
  /** Trusted http(s) origin bound into each controller. */
  readonly origin: string;
  /** Fetch implementation forwarded to each controller. */
  readonly fetch?: Parameters<typeof createComponentController>[0]['fetch'];
  /** XHR factory forwarded to each controller for file uploads. */
  readonly uploadRequest?: Parameters<typeof createComponentController>[0]['uploadRequest'];
  /** Receives upload progress for a bound file input. */
  readonly onUploadProgress?: (
    field: string,
    input: ComponentElement,
    progress: ComponentUploadProgress,
  ) => void;
  /** Visibility/connectivity signals driving poll pause/resume. */
  readonly pollSignals?: PollSignals;
  /** Called instead of `console.warn` for non-fatal binding failures. */
  readonly onError?: (error: unknown, element: ComponentElement) => void;
  /**
   * Navigation callback invoked when a server-component action signals a
   * client-side redirect. When absent the binding layer falls back to
   * `globalThis.location.assign` (accessed structurally so the module stays
   * Node-importable). Prefer wiring this to Turbo's `visit()` so redirects
   * preserve the soft-navigation session rather than performing a full page
   * load.
   */
  readonly navigate?: (url: string) => void;
  /**
   * Confirmation prompt called before dispatching an action. Returns `true`
   * to proceed or `false` to cancel. Defaults to `globalThis.window.confirm`,
   * falling back to `true` (allow) when unavailable (Node/test). Advisory
   * UI only, never a security boundary.
   */
  readonly confirm?: (message: string) => boolean;
  /**
   * Injectable factory for an `IntersectionObserver`. When present, it is
   * called once per observed root instead of reaching for the browser global.
   * When absent, `globalThis.IntersectionObserver` is used as a fallback.
   * When neither is available (Node/test without injection), the intersect
   * directive is a no-op — never throw.
   */
  readonly createIntersectionObserver?: (
    callback: (entries: readonly IntersectionObserverEntryLike[]) => void,
  ) => IntersectionObserverLike;
}

/** The binding manager handle. */
export interface ComponentBindings {
  /** Bootstrap a controller for every unbound root in the document. */
  mountAll(): void;
  /** Bootstrap a controller for `root` (if it is a root) and every root inside. */
  mountWithin(root: ComponentElement): void;
  /** Dispose every controller and remove delegated listeners. Idempotent. */
  disposeAll(): void;
  /** Dispose controllers whose root element is no longer connected. */
  collectRemoved(): void;
  /** Number of live bindings. */
  readonly size: number;
  /**
   * Return the element whose `data-jsails-ref` equals `name` within `root`,
   * or `null` when no match exists. Pure, non-throwing lookup aid — never
   * a global id lookup.
   */
  findRef(root: ComponentElement, name: string): ComponentElement | null;
}

/** Create the DOM binding manager over a document and morph function. */
export function createComponentBindings(options: ComponentBindingsOptions): ComponentBindings {
  const {
    document: doc,
    morph,
    islands,
    origin,
    fetch,
    uploadRequest,
    onUploadProgress,
    pollSignals,
    onError,
    navigate,
    confirm,
    createIntersectionObserver,
  } = options;
  if (typeof morph !== 'function') {
    throw new ComponentBindingError('morph must be a function');
  }
  if (typeof origin !== 'string' || origin === '') {
    throw new ComponentBindingError('origin must be a non-empty string');
  }
  if (pollSignals !== undefined && typeof pollSignals.onChange !== 'function') {
    throw new ComponentBindingError('pollSignals.onChange must be a function');
  }
  const signals = pollSignals ?? defaultPollSignals();

  const bindings = new Map<ComponentElement, RootBinding>();
  let listenersAttached = false;

  function report(error: unknown, element: ComponentElement): void {
    if (onError !== undefined) {
      onError(error, element);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`jsails: component binding failed: ${message}`);
  }

  /** Resolve the nearest component root for an event target, if any. */
  function rootFor(target: ComponentElement | null): ComponentElement | null {
    if (target === null) {
      return null;
    }
    // A control owned by a client island is out of scope: the island owns it.
    if (target.closest(ISLAND_SELECTOR) !== null) {
      return null;
    }
    // A control inside an ignored subtree is excluded from capture and
    // dispatch — same shape as the island exclusion.
    if (target.closest(IGNORE_SELECTOR) !== null) {
      return null;
    }
    return target.closest(ROOT_SELECTOR);
  }

  /**
   * Show a confirmation prompt before dispatching an action. Advisory UI
   * only, never a security boundary: when `window.confirm` is unavailable
   * (Node/test), the message is treated as confirmed so the action proceeds.
   */
  function confirmDialog(message: string): boolean {
    if (confirm !== undefined) {
      return confirm(message);
    }
    const g = globalThis as { window?: { confirm(message: string): boolean } };
    return g.window?.confirm?.(message) ?? true;
  }

  /** Show the fixed blocked message as plaintext (never raw response HTML). */
  function showBlocked(binding: RootBinding): void {
    binding.element.textContent = COMPONENT_BLOCKED_MESSAGE;
  }

  /**
   * Apply render-time directives across the binding's root: `show` toggles
   * visibility based on a state field's truthiness, and `text` sets
   * `textContent` (never `innerHTML` — XSS safety). Both are idempotent and
   * safe to call on every marker sync.
   */
  function applyDirectives(binding: RootBinding): void {
    // Show directive: every `[data-jsails-show]` element is hidden when its
    // named state field is falsy or missing; shown when truthy.
    for (const element of Array.from(binding.element.querySelectorAll(`[${SHOW_ATTRIBUTE}]`))) {
      const field = element.getAttribute(SHOW_ATTRIBUTE);
      if (field === null || field === '') {
        continue;
      }
      const visible = !!binding.controller.state[field];
      if (typeof element.hidden === 'boolean') {
        element.hidden = !visible;
      } else {
        // Test doubles that lack `hidden`: toggle a data attribute so the
        // app's CSS can apply `display:none` via `[data-jsails-hidden]`.
        if (visible) {
          element.removeAttribute('data-jsails-hidden');
        } else {
          element.setAttribute('data-jsails-hidden', '');
        }
      }
    }

    // Text directive: every `[data-jsails-text]` element gets its textContent
    // set to the string form of the named field. `innerHTML` is never set
    // because a field value is untrusted user content and must never be
    // parsed as HTML (XSS).
    for (const element of Array.from(binding.element.querySelectorAll(`[${TEXT_ATTRIBUTE}]`))) {
      const field = element.getAttribute(TEXT_ATTRIBUTE);
      if (field === null || field === '') {
        continue;
      }
      const value = binding.controller.state[field];
      if (value === null || value === undefined) {
        element.textContent = '';
      } else if (typeof value === 'object') {
        element.textContent = JSON.stringify(value);
      } else {
        element.textContent = String(value);
      }
    }
  }

  /** Set or clear the loading/dirty markers across a root and its controls. */
  function syncMarkers(binding: RootBinding): void {
    if (binding.disposed) {
      return;
    }
    if (binding.controller.inflight > 0) {
      binding.element.setAttribute(LOADING_ATTRIBUTE, 'true');
    } else {
      binding.element.removeAttribute(LOADING_ATTRIBUTE);
    }
    if (binding.controller.isDirty()) {
      binding.element.setAttribute(DIRTY_ATTRIBUTE, 'true');
    } else {
      binding.element.removeAttribute(DIRTY_ATTRIBUTE);
    }
    for (const control of Array.from(binding.element.querySelectorAll(MODEL_SELECTOR))) {
      if (rootFor(control) !== binding.element) {
        continue;
      }
      const name = control.getAttribute(MODEL_ATTRIBUTE);
      if (name === null || name === '') {
        continue;
      }
      if (binding.controller.isDirty(name)) {
        control.setAttribute(DIRTY_ATTRIBUTE, 'true');
      } else {
        control.removeAttribute(DIRTY_ATTRIBUTE);
      }
    }
    // Loading-target directive: toggle the loading marker on a named target
    // element within the root while a request is in flight. A missing target
    // or a malformed selector is silently ignored (advisory UI, not critical).
    const loadingTarget = binding.element.getAttribute(LOADING_TARGET_ATTRIBUTE);
    if (loadingTarget !== null && loadingTarget !== '') {
      try {
        const target = binding.element.querySelector(loadingTarget);
        if (target !== null) {
          if (binding.controller.inflight > 0) {
            target.setAttribute(LOADING_ATTRIBUTE, 'true');
          } else {
            target.removeAttribute(LOADING_ATTRIBUTE);
          }
        }
      } catch {
        // A malformed CSS selector must not break the binding.
      }
    }
    applyDirectives(binding);
  }

  /**
   * Observe every `[data-jsails-intersect]` element in the binding's root.
   * When an element enters the viewport the named action is dispatched once,
   * then the element is unobserved — fire-once semantics so a scroll-off/
   * scroll-back does not re-trigger the same element. The observer is
   * disconnected and re-created on every morphed render so the new subtree's
   * intersect elements are rediscovered.
   *
   * A root with no intersect elements skips observer creation entirely
   * (no needless IntersectionObserver).
   */
  function observeIntersections(binding: RootBinding): void {
    const elements = Array.from(binding.element.querySelectorAll(`[${INTERSECT_ATTRIBUTE}]`));
    if (elements.length === 0) {
      return;
    }

    // Resolve the observer factory: injected option first, then the browser
    // global, then null (no-op). Accessed lazily so Node/test environments
    // that supply neither option nor global never throw.
    let observer: IntersectionObserverLike | null = null;
    if (createIntersectionObserver !== undefined) {
      observer = createIntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || binding.disposed) {
            continue;
          }
          const element = entry.target;
          const action = element.getAttribute(INTERSECT_ATTRIBUTE);
          if (action === null || action === '') {
            continue;
          }
          try {
            captureBoundValues(binding, rootFor, report);
            cancelAllDebounce(binding);
            void binding.controller.commit(action, {}).catch((error: unknown) => {
              report(error, element);
            });
          } finally {
            // Fire-once: after dispatch (success or failure), unobserve so a
            // re-entry never re-dispatches. A retry on scroll-back would
            // produce duplicate side effects for idempotent handlers and
            // unbounded work for non-idempotent ones.
            observer?.unobserve(element);
          }
        }
      });
    } else {
      // In a browser, `globalThis.IntersectionObserver` is available.
      // Accessed structurally so the module stays Node-importable.
      const g = globalThis as {
        IntersectionObserver?: new (
          callback: (entries: readonly IntersectionObserverEntryLike[]) => void,
        ) => IntersectionObserverLike;
      };
      if (g.IntersectionObserver !== undefined) {
        observer = new g.IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting || binding.disposed) {
              continue;
            }
            const element = entry.target;
            const action = element.getAttribute(INTERSECT_ATTRIBUTE);
            if (action === null || action === '') {
              continue;
            }
            try {
              captureBoundValues(binding, rootFor, report);
              cancelAllDebounce(binding);
              void binding.controller.commit(action, {}).catch((error: unknown) => {
                report(error, element);
              });
            } finally {
              // Fire-once: unobserve after dispatch. See rationale above.
              observer?.unobserve(element);
            }
          }
        });
      }
    }

    if (observer === null) {
      return;
    }
    binding.intersectionObserver = observer;
    for (const element of elements) {
      observer.observe(element);
    }
  }

  /**
   * Parse a root's `data-jsails-poll` marker into poll options; `null` when
   * absent or malformed. Bounded by {@link MAX_POLL_MARKER_LENGTH} and
   * {@link MIN_POLL_INTERVAL_MS} so a hostile marker never drives a tight loop.
   */
  function parsePollOptions(binding: RootBinding): ComponentPollOptions | null {
    const raw = binding.element.getAttribute(POLL_ATTRIBUTE);
    if (raw === null || raw === '' || raw.length > MAX_POLL_MARKER_LENGTH) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const intervalMs = record.intervalMs;
    if (
      typeof intervalMs !== 'number' ||
      !Number.isSafeInteger(intervalMs) ||
      intervalMs < MIN_POLL_INTERVAL_MS
    ) {
      return null;
    }
    return {
      intervalMs,
      pauseWhenHidden: record.pauseWhenHidden === true,
      pauseWhenOffline: record.pauseWhenOffline === true,
    };
  }

  /**
   * Start a recursive poll loop on a binding. Each iteration awaits a
   * `refresh()` (a no-op re-render) before scheduling the next, so updates never
   * overlap. Pauses while the signals report hidden/offline and stops when the
   * controller is disposed or blocked.
   */
  function startPolling(binding: RootBinding, options: ComponentPollOptions): void {
    let stopped = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const isPaused = (): boolean =>
      (options.pauseWhenHidden === true && binding.signals.hidden) ||
      (options.pauseWhenOffline === true && !binding.signals.online);

    const clearTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const ensureScheduled = (): void => {
      if (stopped || binding.disposed || binding.controller.blocked) {
        return;
      }
      if (isPaused() || running || timer !== null) {
        return;
      }
      timer = setTimeout(() => {
        void tick();
      }, options.intervalMs);
    };

    const tick = async (): Promise<void> => {
      timer = null;
      running = true;
      try {
        if (stopped || binding.disposed || binding.controller.blocked || isPaused()) {
          return;
        }
        await binding.controller.refresh();
      } catch {
        // A refresh failure marks the controller blocked, which stops the loop.
      } finally {
        running = false;
      }
      ensureScheduled();
    };

    const unsubscribe = binding.signals.onChange(() => {
      if (stopped) {
        return;
      }
      if (isPaused() || binding.disposed || binding.controller.blocked) {
        clearTimer();
        return;
      }
      ensureScheduled();
    });

    ensureScheduled();

    binding.poll = {
      stop(): void {
        if (stopped) {
          return;
        }
        stopped = true;
        clearTimer();
        unsubscribe();
      },
    };
  }

  /** Read a control's `data-jsails-debounce` marker; `null` when absent/invalid. */
  function debounceMsFor(control: ComponentElement): number | null {
    const raw = control.getAttribute(DEBOUNCE_ATTRIBUTE);
    if (raw === null || raw === '') {
      return null;
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_DEBOUNCE_MS) {
      return null;
    }
    return parsed;
  }

  /** Schedule (or reschedule) a field's debounce flush via `sync()`. */
  function scheduleDebounce(binding: RootBinding, name: string, ms: number): void {
    const existing = binding.debounce.get(name);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      binding.debounce.delete(name);
      if (binding.disposed || binding.controller.blocked || !binding.controller.isDirty()) {
        return;
      }
      void binding.controller.sync().catch(() => {
        // Sync failures surface through the controller's onError; nothing more.
      });
    }, ms);
    binding.debounce.set(name, timer);
  }

  /** Cancel a field's pending debounce timer, if any. */
  function cancelDebounce(binding: RootBinding, name: string): void {
    const existing = binding.debounce.get(name);
    if (existing !== undefined) {
      clearTimeout(existing);
      binding.debounce.delete(name);
    }
  }

  /** Cancel every pending debounce timer (submit/click/dispose). */
  function cancelAllDebounce(binding: RootBinding): void {
    for (const timer of binding.debounce.values()) {
      clearTimeout(timer);
    }
    binding.debounce.clear();
  }

  /** Flush a field's pending edit immediately (blur); a no-op when not dirty. */
  function flushDebounce(binding: RootBinding, name: string): void {
    cancelDebounce(binding, name);
    if (binding.disposed || binding.controller.blocked || !binding.controller.isDirty(name)) {
      return;
    }
    void binding.controller.sync().catch(() => {
      // Sync failures surface through the controller's onError; nothing more.
    });
  }

  /** Morph a render into the root, retargeting and reapplying local edits. */
  async function applyRender(binding: RootBinding, render: ComponentRender): Promise<void> {
    if (binding.disposed) {
      return;
    }
    const targetId = binding.element.id;
    if (targetId === '') {
      throw new ComponentBindingError('component root must have an id');
    }

    // Tear down nested islands before the subtree is replaced, then remount
    // them (and any new ones) through the shared manager.
    const restore = islands?.beforeMorph(binding.element);
    try {
      await morph(targetId, render.html);
    } finally {
      const next = doc.getElementById(targetId);
      if (next !== null && next !== binding.element) {
        const previous = binding.element;
        binding.element = next;
        // Re-key the element-keyed map so delegated events that resolve the
        // replacement root find this same binding. The controller and its
        // working state are preserved by identity.
        bindings.delete(previous);
        bindings.set(next, binding);
      }
      restore?.();
      islands?.mountWithin(binding.element);
    }

    if (binding.disposed) {
      return;
    }
    // The server HTML carries the new snapshot, but pin it explicitly so a
    // cache snapshot taken before the next render is never stale.
    binding.element.setAttribute(COMPONENT_SNAPSHOT_ATTRIBUTE, render.snapshot);
    // Re-emit the legacy readiness marker on the (possibly replaced) root.
    binding.element.setAttribute(ISLAND_HYDRATED_ATTRIBUTE, 'true');
    reapplyWorkingValues(binding, rootFor);
    syncMarkers(binding);
    // The morphed subtree replaces the old DOM. Disconnect the previous
    // observer (watching elements that no longer exist) and re-observe the
    // new subtree's intersect elements. A root with none creates no observer.
    if (binding.intersectionObserver !== null) {
      binding.intersectionObserver.disconnect();
      binding.intersectionObserver = null;
    }
    observeIntersections(binding);
    // When the server action signaled a redirect, navigate after the render is
    // applied. The URL was validated server-side (scheme check, no control
    // chars), so the client trusts it as producer output. Prefer the injected
    // `navigate` callback (wired to Turbo.visit for soft navigation) over a
    // full-page `location.assign`; if neither is available (Node/test), the
    // redirect is silently ignored — a test should assert on the render object.
    if (render.redirect !== undefined) {
      if (typeof navigate === 'function') {
        navigate(render.redirect);
      } else {
        const loc = (globalThis as { location?: { assign?: (url: string) => void } }).location;
        if (typeof loc?.assign === 'function') {
          loc.assign(render.redirect);
        }
      }
    }
  }

  function createBinding(element: ComponentElement): RootBinding | null {
    const snapshot = element.getAttribute(COMPONENT_SNAPSHOT_ATTRIBUTE);
    const csrfToken = element.getAttribute(COMPONENT_CSRF_ATTRIBUTE);
    if (snapshot === null || snapshot === '' || csrfToken === null || csrfToken === '') {
      report(
        new ComponentBindingError('component root is missing its snapshot or CSRF marker'),
        element,
      );
      return null;
    }

    let binding: RootBinding;
    let controller: ComponentController;
    try {
      controller = createComponentController({
        snapshot,
        csrfToken,
        origin,
        ...(fetch === undefined ? {} : { fetch }),
        ...(uploadRequest === undefined ? {} : { uploadRequest }),
        ...(onUploadProgress === undefined
          ? {}
          : {
              onUploadProgress: (field, progress) => {
                if (binding.disposed) {
                  return;
                }
                const input = findUploadInput(binding, field);
                if (input === null) {
                  return;
                }
                onUploadProgress(field, input, progress);
              },
            }),
        onRender: (render) => applyRender(binding, render),
        onInflightChange: () => {
          if (binding.disposed) {
            return;
          }
          syncMarkers(binding);
        },
        onError: (error) => {
          if (binding.disposed) {
            return;
          }
          // A fatal controller error permanently blocks the component; show a
          // fixed plaintext message rather than any response body.
          if (error instanceof ComponentControllerError && error.code !== 'invalid_options') {
            showBlocked(binding);
          }
          report(error, binding.element);
        },
      });
    } catch (error) {
      report(error, element);
      return null;
    }

    binding = {
      element,
      controller,
      uploadErrors: new WeakMap(),
      debounce: new Map(),
      poll: null,
      signals,
      disposed: false,
      intersectionObserver: null,
    };
    // Legacy readiness signal, emitted alongside the framework marker so a
    // browser fixture (and existing consumers) can wait on `data-hydrated`.
    element.setAttribute(ISLAND_HYDRATED_ATTRIBUTE, 'true');
    syncMarkers(binding);

    // A poll marker is read once at binding creation; a later morph does not
    // restart or retune an already-running poll.
    const pollOptions = parsePollOptions(binding);
    if (pollOptions !== null) {
      startPolling(binding, pollOptions);
    }
    // Observe intersect elements in the initial subtree. A root with no
    // `[data-jsails-intersect]` elements skips observer creation entirely.
    observeIntersections(binding);
    return binding;
  }

  function bindElement(element: ComponentElement): void {
    if (bindings.has(element)) {
      return;
    }
    if (element.getAttribute(COMPONENT_ATTRIBUTE) === null) {
      return;
    }
    const binding = createBinding(element);
    if (binding !== null) {
      bindings.set(element, binding);
    }
  }

  function bindWithin(root: ComponentElement): void {
    bindElement(root);
    for (const element of Array.from(root.querySelectorAll(ROOT_SELECTOR))) {
      bindElement(element);
    }
  }

  function disposeBinding(binding: RootBinding): void {
    if (binding.disposed) {
      return;
    }
    binding.disposed = true;
    binding.poll?.stop();
    binding.poll = null;
    cancelAllDebounce(binding);
    // Disconnect the intersection observer watching `[data-jsails-intersect]`
    // elements. Idempotent: a binding with no intersect elements has a null
    // observer and `null?.disconnect()` is a no-op.
    binding.intersectionObserver?.disconnect();
    binding.intersectionObserver = null;
    binding.controller.dispose();
    binding.element.removeAttribute(ISLAND_HYDRATED_ATTRIBUTE);
    bindings.delete(binding.element);
  }

  // -------------------------------------------------------------------------
  // Delegated event handlers
  // -------------------------------------------------------------------------

  function onInputOrChange(event: JsailsEvent): void {
    const target = event.target as ComponentElement | null;
    const root = rootFor(target);
    if (root === null || target === null) {
      return;
    }
    const binding = bindings.get(root);
    if (binding === undefined || binding.disposed) {
      return;
    }
    const name = target.getAttribute(MODEL_ATTRIBUTE);
    if (name === null || name === '') {
      return;
    }

    // A file control's value is never serializable state: a `change` with a
    // selected file starts an upload, and an `input` event on one carries
    // nothing to capture.
    if (isFileInput(target)) {
      if (event.type === 'change') {
        handleFileChange(binding, target, name, doc, report);
      }
      return;
    }

    try {
      const value = readControlValue(target);
      binding.controller.setField(name, value);
      const debounceMs = debounceMsFor(target);
      if (debounceMs !== null) {
        scheduleDebounce(binding, name, debounceMs);
      }
      syncMarkers(binding);
      applyFieldValidation(binding, target, name, value);
    } catch (error) {
      report(error, target);
    }
  }

  function onFocusOut(event: JsailsEvent): void {
    const target = event.target as ComponentElement | null;
    const root = rootFor(target);
    if (root === null || target === null) {
      return;
    }
    const binding = bindings.get(root);
    if (binding === undefined || binding.disposed) {
      return;
    }
    const name = target.getAttribute(MODEL_ATTRIBUTE);
    if (name === null || name === '') {
      return;
    }
    // Only a debounced control flushes its pending edit on blur.
    if (debounceMsFor(target) === null) {
      return;
    }
    flushDebounce(binding, name);
  }

  function onCallClick(event: JsailsEvent): void {
    const target = event.target as ComponentElement | null;
    if (target === null) {
      return;
    }

    // CALL_ATTRIBUTE takes precedence: when the element (or an ancestor)
    // carries an explicit call marker, dispatch that action directly.
    const callTrigger = target.closest(`[${CALL_ATTRIBUTE}]`);
    if (callTrigger !== null) {
      const root = rootFor(callTrigger);
      if (root === null) {
        return;
      }
      const binding = bindings.get(root);
      if (binding === undefined || binding.disposed) {
        return;
      }
      const action = callTrigger.getAttribute(CALL_ATTRIBUTE);
      if (action === null || action === '') {
        return;
      }
      const args = parseActionArgs(callTrigger.getAttribute(ARGS_ATTRIBUTE));
      if (args === null) {
        report(new ComponentBindingError('invalid action arguments'), callTrigger);
        return;
      }
      // Confirmation guard: advisory UI only, not a security boundary. The
      // element's `data-jsails-confirm` value carries the exact message.
      const confirmMessage = callTrigger.getAttribute(CONFIRM_ATTRIBUTE);
      if (confirmMessage !== null && confirmMessage !== '' && !confirmDialog(confirmMessage)) {
        return;
      }
      // Only a bound action suppresses the native/Turbo default.
      event.preventDefault();
      captureBoundValues(binding, rootFor, report);
      cancelAllDebounce(binding);
      void binding.controller.commit(action, args).catch((error: unknown) => {
        report(error, callTrigger);
      });
      return;
    }

    // Fall back to SORT_ATTRIBUTE: clicking a sort trigger dispatches a 'sort'
    // action with the named field. When the same element carries both
    // CALL_ATTRIBUTE and SORT_ATTRIBUTE, the explicit call wins (checked first).
    const sortTrigger = target.closest(`[${SORT_ATTRIBUTE}]`);
    if (sortTrigger === null) {
      return;
    }
    const root = rootFor(sortTrigger);
    if (root === null) {
      return;
    }
    const binding = bindings.get(root);
    if (binding === undefined || binding.disposed) {
      return;
    }
    const field = sortTrigger.getAttribute(SORT_ATTRIBUTE);
    if (field === null || field === '') {
      return;
    }
    event.preventDefault();
    captureBoundValues(binding, rootFor, report);
    cancelAllDebounce(binding);
    void binding.controller.commit('sort', { field }).catch((error: unknown) => {
      report(error, sortTrigger);
    });
  }

  function onSubmit(event: JsailsEvent): void {
    const target = event.target as ComponentElement | null;
    if (target === null) {
      return;
    }
    const form = target.closest(`[${SUBMIT_ATTRIBUTE}]`);
    if (form === null) {
      return;
    }
    const root = rootFor(form);
    if (root === null) {
      return;
    }
    const binding = bindings.get(root);
    if (binding === undefined || binding.disposed) {
      return;
    }
    const action = form.getAttribute(SUBMIT_ATTRIBUTE);
    if (action === null || action === '') {
      return;
    }
    const args = parseActionArgs(form.getAttribute(ARGS_ATTRIBUTE));
    if (args === null) {
      report(new ComponentBindingError('invalid action arguments'), form);
      return;
    }
    // Confirmation guard: read from the form element before client-side
    // validation. Advisory UI only, not a security boundary.
    const confirmMessage = form.getAttribute(CONFIRM_ATTRIBUTE);
    if (confirmMessage !== null && confirmMessage !== '' && !confirmDialog(confirmMessage)) {
      return;
    }
    // Client-side validation gate: when any bound field fails its rules, block
    // the submit and move focus to the first invalid control. The action is
    // never dispatched; the server's own validation is not consulted.
    const firstInvalid = validateAll(binding, rootFor);
    if (firstInvalid !== null) {
      event.preventDefault();
      firstInvalid.focus?.();
      return;
    }
    // Only a bound submit suppresses the native/Turbo default.
    event.preventDefault();
    captureBoundValues(binding, rootFor, report);
    cancelAllDebounce(binding);
    void binding.controller.commit(action, args).catch((error: unknown) => {
      report(error, form);
    });
  }

  /**
   * Return the element whose `data-jsails-ref` equals `name` within `root`,
   * or `null` when no match exists. Pure, non-throwing lookup aid.
   */
  function findRef(root: ComponentElement, name: string): ComponentElement | null {
    if (name === '') {
      return null;
    }
    // Iterate descendants directly rather than using a CSS attribute-value
    // selector, so the lookup works against minimal test doubles whose
    // `querySelectorAll` only supports `[attr]` presence checks (no value
    // matching). In a real browser both approaches are equivalent.
    for (const element of Array.from(root.querySelectorAll(`[${REF_ATTRIBUTE}]`))) {
      if (element.getAttribute(REF_ATTRIBUTE) === name) {
        return element;
      }
    }
    return null;
  }

  function attachListeners(): void {
    if (listenersAttached) {
      return;
    }
    listenersAttached = true;
    doc.addEventListener('input', onInputOrChange);
    doc.addEventListener('change', onInputOrChange);
    doc.addEventListener('click', onCallClick);
    doc.addEventListener('submit', onSubmit);
    doc.addEventListener('focusout', onFocusOut);
  }

  function detachListeners(): void {
    if (!listenersAttached) {
      return;
    }
    listenersAttached = false;
    doc.removeEventListener('input', onInputOrChange);
    doc.removeEventListener('change', onInputOrChange);
    doc.removeEventListener('click', onCallClick);
    doc.removeEventListener('submit', onSubmit);
    doc.removeEventListener('focusout', onFocusOut);
  }

  return {
    mountAll() {
      attachListeners();
      for (const element of Array.from(doc.querySelectorAll(ROOT_SELECTOR))) {
        bindElement(element as ComponentElement);
      }
    },
    mountWithin(root) {
      attachListeners();
      bindWithin(root);
    },
    disposeAll() {
      detachListeners();
      for (const binding of Array.from(bindings.values())) {
        disposeBinding(binding);
      }
    },
    collectRemoved() {
      for (const binding of Array.from(bindings.values())) {
        if (!binding.element.isConnected) {
          disposeBinding(binding);
        }
      }
    },
    get size() {
      return bindings.size;
    },
    findRef,
  };
}

// Re-export the public helpers moved into the per-concern submodules so the
// barrel's public surface stays unchanged.
export { COMPONENT_UPLOAD_FAILED_MESSAGE, evaluateFieldRules, parseFieldRules, readControlValue };
