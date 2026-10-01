/**
 * Browser DOM binding layer ("DOMglue") for stateful server components.
 *
 * This is the DOM half of the component story. The pure controller in
 * `component-state.ts` owns the client model, the serialized update queue, and
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

import type { JsonObject, JsonValue } from '../contracts/http.js';
import {
  ARGS_ATTRIBUTE,
  CALL_ATTRIBUTE,
  COMPONENT_ATTRIBUTE,
  COMPONENT_CSRF_ATTRIBUTE,
  COMPONENT_SNAPSHOT_ATTRIBUTE,
  MODEL_ATTRIBUTE,
  SUBMIT_ATTRIBUTE,
} from '../server-components/protocol.js';
import {
  ComponentControllerError,
  createComponentController,
  type ComponentController,
  type ComponentRender,
} from './component-state.js';
import {
  ISLAND_ATTRIBUTE,
  ISLAND_HYDRATED_ATTRIBUTE,
  type IslandManager,
  type JsailsDocument,
  type JsailsElement,
  type JsailsEvent,
} from './islands.js';

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
  querySelector(selector: string): ComponentElement | null;
  querySelectorAll(selector: string): ArrayLike<ComponentElement>;
  closest(selector: string): ComponentElement | null;
  addEventListener(type: string, listener: (event: JsailsEvent) => void, options?: unknown): void;
  removeEventListener(
    type: string,
    listener: (event: JsailsEvent) => void,
    options?: unknown,
  ): void;
}

/** The slice of `document` the binding layer touches. */
export interface ComponentDocument extends JsailsDocument {
  querySelector(selector: string): ComponentElement | null;
  getElementById(id: string): ComponentElement | null;
}

/** A morph function: render `html` into the element with `target` id. */
export type ComponentMorph = (target: string, html: string) => Promise<void>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fixed plaintext shown when a component is permanently blocked. */
export const COMPONENT_BLOCKED_MESSAGE =
  'This component could not be updated. Reload the page to try again.';

/** Selector for a component root. */
const ROOT_SELECTOR = `[${COMPONENT_ATTRIBUTE}]`;

/** Selector for a model-bound control. */
const MODEL_SELECTOR = `[${MODEL_ATTRIBUTE}]`;

/** Selector for a client island (its controls are out of scope). */
const ISLAND_SELECTOR = `[${ISLAND_ATTRIBUTE}]`;

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
// Native control value extraction
// ---------------------------------------------------------------------------

/**
 * Read a native control's value as a JSON value: a checkbox/radio yields its
 * `checked` boolean, a multi-select yields an array of selected values, a
 * numeric input yields a number when finite, and everything else yields its
 * string value.
 */
export function readControlValue(element: ComponentElement): JsonValue {
  const type = (element.type ?? '').toLowerCase();
  if (type === 'checkbox' || type === 'radio') {
    return element.checked === true;
  }
  if (element.tagName.toLowerCase() === 'select' && element.multiple === true) {
    const selected = element.selectedOptions;
    if (selected === undefined) {
      return [];
    }
    return Array.from(selected, (option) => option.value);
  }
  const raw = element.value ?? '';
  if (type === 'number' || type === 'range') {
    if (raw.trim() === '') {
      return '';
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  return raw;
}

/** Write a JSON value back onto a native control. */
function writeControlValue(element: ComponentElement, value: JsonValue): void {
  const type = (element.type ?? '').toLowerCase();
  if (type === 'checkbox' || type === 'radio') {
    element.checked = value === true;
    return;
  }
  if (element.tagName.toLowerCase() === 'select' && element.multiple === true) {
    const wanted = new Set(Array.isArray(value) ? value.map((entry) => String(entry)) : []);
    const options = element.querySelectorAll('option');
    for (const option of Array.from(options)) {
      const optionValue = option.getAttribute('value') ?? option.value ?? '';
      option.setAttribute('selected', wanted.has(optionValue) ? '' : 'false');
    }
    return;
  }
  element.value = value === null || value === undefined ? '' : String(value);
}

/** True when a control's current DOM value already equals `value`. */
function controlMatches(element: ComponentElement, value: JsonValue): boolean {
  const current = readControlValue(element);
  if (Array.isArray(current) && Array.isArray(value)) {
    if (current.length !== value.length) {
      return false;
    }
    return current.every((entry, index) => entry === value[index]);
  }
  return current === value;
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

/** A live binding between one component root and its controller. */
interface RootBinding {
  element: ComponentElement;
  readonly controller: ComponentController;
  disposed: boolean;
}

/** Options for {@link createComponentBindings}. */
export interface CreateComponentBindingsOptions {
  readonly document: ComponentDocument;
  /** Morphs server HTML into the root by element id. */
  readonly morph: ComponentMorph;
  /** Shared island manager, used to tear down/remount nested islands. */
  readonly islands?: IslandManager;
  /** Trusted http(s) origin bound into each controller. */
  readonly origin: string;
  /** Fetch implementation forwarded to each controller. */
  readonly fetch?: Parameters<typeof createComponentController>[0]['fetch'];
  /** Called instead of `console.warn` for non-fatal binding failures. */
  readonly onError?: (error: unknown, element: ComponentElement) => void;
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
}

/** Create the DOM binding manager over a document and morph function. */
export function createComponentBindings(
  options: CreateComponentBindingsOptions,
): ComponentBindings {
  const { document: doc, morph, islands, origin, fetch, onError } = options;
  if (typeof morph !== 'function') {
    throw new ComponentBindingError('morph must be a function');
  }
  if (typeof origin !== 'string' || origin === '') {
    throw new ComponentBindingError('origin must be a non-empty string');
  }

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
    return target.closest(ROOT_SELECTOR);
  }

  /** Collect the latest bound field values from the DOM into the controller. */
  function captureBoundValues(binding: RootBinding): void {
    const controls = binding.element.querySelectorAll(MODEL_SELECTOR);
    for (const control of Array.from(controls)) {
      // A control owned by a nested island or a nested component root belongs
      // to that owner, never to this binding; resolve ownership the same way
      // delegated events do so capture and dispatch agree.
      if (rootFor(control) !== binding.element) {
        continue;
      }
      const name = control.getAttribute(MODEL_ATTRIBUTE);
      if (name === null || name === '') {
        continue;
      }
      try {
        binding.controller.setField(name, readControlValue(control));
      } catch (error) {
        report(error, control);
      }
    }
  }

  /** Reapply working values to controls, leaving unchanged controls untouched. */
  function reapplyWorkingValues(binding: RootBinding): void {
    const state = binding.controller.state;
    const controls = binding.element.querySelectorAll(MODEL_SELECTOR);
    for (const control of Array.from(controls)) {
      // Never write this component's working values onto a control owned by a
      // nested island or a nested component root.
      if (rootFor(control) !== binding.element) {
        continue;
      }
      const name = control.getAttribute(MODEL_ATTRIBUTE);
      if (name === null || !Object.hasOwn(state, name)) {
        continue;
      }
      const value = state[name] as JsonValue;
      // Skip an unchanged control so the browser keeps its caret/selection.
      if (controlMatches(control, value)) {
        continue;
      }
      writeControlValue(control, value);
    }
  }

  /** Show the fixed blocked message as plaintext (never raw response HTML). */
  function showBlocked(binding: RootBinding): void {
    binding.element.textContent = COMPONENT_BLOCKED_MESSAGE;
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
    reapplyWorkingValues(binding);
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
        onRender: (render) => applyRender(binding, render),
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

    binding = { element, controller, disposed: false };
    // Legacy readiness signal, emitted alongside the framework marker so a
    // browser fixture (and existing consumers) can wait on `data-hydrated`.
    element.setAttribute(ISLAND_HYDRATED_ATTRIBUTE, 'true');
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
    try {
      binding.controller.setField(name, readControlValue(target));
    } catch (error) {
      report(error, target);
    }
  }

  function onCallClick(event: JsailsEvent): void {
    const target = event.target as ComponentElement | null;
    if (target === null) {
      return;
    }
    const trigger = target.closest(`[${CALL_ATTRIBUTE}]`);
    if (trigger === null) {
      return;
    }
    const root = rootFor(trigger);
    if (root === null) {
      return;
    }
    const binding = bindings.get(root);
    if (binding === undefined || binding.disposed) {
      return;
    }
    const action = trigger.getAttribute(CALL_ATTRIBUTE);
    if (action === null || action === '') {
      return;
    }
    const args = parseActionArgs(trigger.getAttribute(ARGS_ATTRIBUTE));
    if (args === null) {
      report(new ComponentBindingError('invalid action arguments'), trigger);
      return;
    }
    // Only a bound action suppresses the native/Turbo default.
    event.preventDefault();
    captureBoundValues(binding);
    void binding.controller.commit(action, args).catch((error: unknown) => {
      report(error, trigger);
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
    // Only a bound submit suppresses the native/Turbo default.
    event.preventDefault();
    captureBoundValues(binding);
    void binding.controller.commit(action, args).catch((error: unknown) => {
      report(error, form);
    });
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
  };
}
