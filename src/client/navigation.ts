/**
 * Browser navigation runtime: Turbo Drive integration for islands.
 *
 * Turbo Drive owns all link interception and history — this module never
 * installs its own click handler, `history` manipulation, or router. It loads
 * `@hotwired/turbo` dynamically inside browser initialization (never at module
 * scope, so a Node/SSR import of this file does not crash on Turbo's top-level
 * `document`/`window` access), starts the shared Turbo session, and wires the
 * island manager (`islands.ts`) to Turbo's navigation lifecycle so islands are
 * hydrated once per element and torn down/restored before Turbo caches or swaps
 * the body.
 *
 * It also exposes two seams:
 *
 * - `morphComponent(target, html)` — renders a `<turbo-stream action="replace"
 *   method="morph">` message via `Turbo.renderStreamMessage` and awaits the
 *   actual morph (see {@link renderMorphAndAwait}), so the component binding
 *   layer can morph server-rendered content in place and know when it landed.
 * - `jsails:before-navigation` — a cancelable custom document event (plus an
 *   `onBeforeNavigation` callback) dispatched before a navigation commits, so a
 *   runtime can cancel stale in-flight actions.
 *
 * The component binding layer (`components.ts`) is wired here: `startClient`
 * auto-enables it after navigation init, and the runtime disposes its
 * controllers before a Turbo navigation and rebinds them after a render/load.
 */

import {
  createComponentBindings,
  type ComponentBindings,
  type ComponentDocument,
} from './components.js';
import {
  createIslandManager,
  createIslandRegistry,
  ISLAND_ATTRIBUTE,
  type IslandMap,
  type IslandManager,
  type IslandRegistry,
  type JsailsDocument,
  type JsailsEvent,
} from './islands.js';

/** Custom document event dispatched before a navigation commits. */
export const JSAILS_BEFORE_NAVIGATION = 'jsails:before-navigation';

/** Generic text shown for a JSails-owned frame whose content is missing. */
export const FRAME_MISSING_MESSAGE = 'This content could not be loaded.';

/**
 * Minimal structural view of the `@hotwired/turbo` module the runtime touches.
 * Declared locally (never imported) so no Turbo-native type leaks into the
 * public `.d.ts`.
 */
export interface TurboModule {
  start(): void;
  renderStreamMessage(message: string): void;
}

/**
 * The slice of a Turbo `StreamElement` the runtime reads to match its own
 * stream message. `requestId` is the `request-id` attribute value.
 */
export interface TurboStreamElement {
  readonly requestId: string | null;
}

/**
 * The `turbo:before-stream-render` event detail. `render` is Turbo's own
 * `StreamElement.renderElement`; wrapping it lets the runtime await the actual
 * morph instead of the (synchronous, enqueue-only) `renderStreamMessage`.
 */
export interface TurboBeforeStreamRenderDetail {
  readonly newStream: TurboStreamElement;
  /** Wrapped in place to observe the morph; Turbo reads it back after dispatch. */
  render: (stream: TurboStreamElement) => Promise<void>;
}

/** The browser scope the runtime operates against. */
export interface BrowserScope {
  readonly document: JsailsDocument;
  /**
   * Builds a cancelable custom event. The default scope uses the real
   * `CustomEvent` constructor; tests inject a structural double.
   */
  readonly createEvent: (
    type: string,
    detail?: unknown,
    options?: { cancelable?: boolean },
  ) => JsailsEvent;
}

/** Raised when `startClient` runs without a browser document/event runtime. */
export class ClientEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientEnvironmentError';
  }
}

/** Detail carried by the `jsails:before-navigation` hook. */
export interface BeforeNavigationDetail {
  /** Destination URL, when known from the preceding `turbo:visit`. */
  readonly url?: string;
  /** Visit action (`advance`/`replace`/`restore`), when known. */
  readonly action?: string;
  /** Turbo render method: `replace` or `morph`. */
  readonly renderMethod?: string;
  /** Whether this render is a cached preview restore. */
  readonly isPreview?: boolean;
}

/** Options for {@link morphComponent}. */
export interface MorphComponentOptions {
  /**
   * Turbo stream action. `replace` morphs the element's outer markup (keeping
   * its identity); `update` morphs its children. Defaults to `replace`.
   */
  readonly action?: 'replace' | 'update';
  /**
   * Bound on how long to wait for the morph to actually render before
   * rejecting. Defaults to {@link MORPH_RENDER_TIMEOUT_MS}.
   */
  readonly timeoutMs?: number;
}

/** Public options for {@link startClient}. */
export interface StartClientOptions {
  /** Declarative island registration, merged with `registerIsland` calls. */
  readonly islands?: IslandMap;
  /** Optional lifecycle hook, in addition to the custom document event. */
  readonly onBeforeNavigation?: (detail: BeforeNavigationDetail) => void;
  /** Called instead of `console.warn` for non-fatal hydration failures. */
  readonly onError?: (error: unknown) => void;
  /**
   * Trusted http(s) origin bound into each component controller. Defaults to
   * the browser's `location.origin`; supply it explicitly behind a proxy.
   */
  readonly componentOrigin?: string;
  /** Fetch implementation forwarded to each component controller. */
  readonly componentFetch?: Parameters<typeof createComponentBindings>[0]['fetch'];
  /** Disable automatic component binding. Defaults to enabled. */
  readonly components?: boolean;
}

/** Internal options for the injectable runtime seam. */
export interface ClientRuntimeOptions extends StartClientOptions {
  readonly scope: BrowserScope;
  /** Turbo loader; defaults to a real dynamic import of `@hotwired/turbo`. */
  readonly loadTurbo?: () => Promise<TurboModule> | TurboModule;
}

/** An assembled browser runtime: idempotent start, morphing, and teardown. */
export interface ClientRuntime {
  readonly started: boolean;
  /** The component binding manager, or `null` when bindings are disabled. */
  readonly bindings: ComponentBindings | null;
  start(): Promise<void>;
  morphComponent(target: string, html: string, options?: MorphComponentOptions): Promise<void>;
  close(): void;
}

/**
 * Memoize an async loader. Concurrent callers share one in-flight promise; a
 * fulfilled load stays cached, while a rejected one drops the cache so the next
 * call retries. The rejection itself is never wrapped or replaced — every
 * caller awaiting the failed attempt sees the original error.
 *
 * Exported for the internal test seam only; deliberately absent from the client
 * barrel (`src/client/index.ts`).
 */
export function createCachedLoader<T>(load: () => Promise<T> | T): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => {
    if (cached !== null) {
      return cached;
    }
    let pending: Promise<T>;
    try {
      // Normalize a synchronous loader; a sync throw becomes a rejection.
      pending = Promise.resolve(load());
    } catch (error) {
      pending = Promise.reject(error);
    }
    cached = pending;
    // Observe the rejection so dropping the cache never surfaces as an
    // unhandled rejection; `pending` still rejects to the callers.
    pending.catch(() => {
      if (cached === pending) {
        cached = null;
      }
    });
    return pending;
  };
}

/** Load the real Turbo module once; a failed attempt leaves the cache empty. */
const loadTurboOnce = createCachedLoader<TurboModule>(() => import('@hotwired/turbo'));
function defaultLoadTurbo(): Promise<TurboModule> {
  return loadTurboOnce();
}

function defaultScope(): BrowserScope {
  const g = globalThis as {
    document?: JsailsDocument;
    CustomEvent?: new <T>(type: string, init?: { detail?: T; cancelable?: boolean }) => JsailsEvent;
  };
  const document = g.document;
  if (document === undefined) {
    throw new ClientEnvironmentError(
      'startClient requires a browser document; call it from client code',
    );
  }
  const CustomEvent = g.CustomEvent;
  return {
    document,
    createEvent(type, detail, options) {
      if (typeof CustomEvent !== 'function') {
        throw new ClientEnvironmentError('CustomEvent constructor is unavailable');
      }
      return new CustomEvent(type, {
        detail,
        cancelable: options?.cancelable ?? true,
      });
    },
  };
}

/** Build a Turbo `<turbo-stream>` morph message for a target and HTML string. */
function buildMorphMessage(
  target: string,
  html: string,
  action: 'replace' | 'update',
  requestId: string,
): string {
  if (typeof target !== 'string' || target.trim() === '' || /[\s"<>]/.test(target)) {
    throw new TypeError('morph target must be a non-empty element id without whitespace or quotes');
  }
  if (typeof html !== 'string') {
    throw new TypeError('morph html must be a string');
  }
  return (
    `<turbo-stream action="${action}" target="${target}" method="morph" ` +
    `request-id="${requestId}">` +
    `<template>${html}</template></turbo-stream>`
  );
}

/** Default bound on how long to wait for a morph stream to actually render. */
export const MORPH_RENDER_TIMEOUT_MS = 10_000;

/** Monotonic id source for owned morph stream messages. */
let morphRequestCounter = 0;

function nextMorphRequestId(): string {
  morphRequestCounter += 1;
  return `jsails-morph-${morphRequestCounter}`;
}

/**
 * Render a morph stream message and await the actual DOM morph.
 *
 * `Turbo.renderStreamMessage` is synchronous and only enqueues the stream
 * element; the morph itself runs later in the element's `connectedCallback`.
 * Turbo dispatches a cancelable `turbo:before-stream-render` event whose
 * `detail.render` performs the morph, so this installs a one-shot listener,
 * matches the stream by its owned `request-id`, wraps `detail.render`, and
 * resolves when that promise settles. A bounded timeout and a `finally`
 * cleanup guarantee the listener is removed and the promise always settles.
 */
async function renderMorphAndAwait(
  doc: JsailsDocument,
  turbo: TurboModule,
  target: string,
  html: string,
  action: 'replace' | 'update',
  timeoutMs: number,
): Promise<void> {
  const requestId = nextMorphRequestId();
  const message = buildMorphMessage(target, html, action, requestId);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      doc.removeEventListener('turbo:before-stream-render', onBeforeStreamRender);
    };

    const settle = (error?: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };

    const onBeforeStreamRender = (event: JsailsEvent): void => {
      const detail = event.detail as TurboBeforeStreamRenderDetail | undefined;
      if (detail === undefined || detail.newStream.requestId !== requestId) {
        return;
      }
      // Take ownership of this stream's render so the morph is awaited rather
      // than fire-and-forget. Turbo's own listener still runs; this wrapper
      // only observes the returned promise.
      const originalRender = detail.render;
      detail.render = (stream) => {
        const rendered = originalRender(stream);
        Promise.resolve(rendered).then(
          () => settle(),
          (error: unknown) => settle(error),
        );
        return rendered;
      };
    };

    doc.addEventListener('turbo:before-stream-render', onBeforeStreamRender);
    timer = setTimeout(() => {
      settle(new Error('timed out waiting for the morph stream to render'));
    }, timeoutMs);

    try {
      turbo.renderStreamMessage(message);
    } catch (error) {
      settle(error);
    }
  });
}

/** Resolve the browser origin for component controllers, or `null`. */
function defaultComponentOrigin(): string | null {
  const location = (globalThis as { location?: { origin?: string } }).location;
  const origin = location?.origin;
  return typeof origin === 'string' && origin !== '' ? origin : null;
}

/** Assemble a runtime over an injected scope and (optional) Turbo loader. */
export function createClientRuntime(options: ClientRuntimeOptions): ClientRuntime {
  const {
    scope,
    loadTurbo = defaultLoadTurbo,
    islands,
    onBeforeNavigation,
    onError,
    componentOrigin,
    componentFetch,
    components = true,
  } = options;

  const registry: IslandRegistry = createIslandRegistry(islands);
  const manager: IslandManager = createIslandManager({
    document: scope.document,
    registry,
    // Only forward a reporter when the caller supplied one; otherwise leave it
    // undefined so the manager's default `console.warn` reporting applies.
    onError:
      onError === undefined
        ? undefined
        : (error) => {
            onError(error);
          },
  });

  let started = false;
  let closed = false;
  let wired = false;
  let turbo: TurboModule | null = null;
  const listeners: Array<[string, (event: JsailsEvent) => void]> = [];
  let lastVisit: { url?: string; action?: string } = {};

  // The binding manager is created lazily on `start` so a Node import never
  // touches `location`, and only when the caller left bindings enabled and an
  // origin is resolvable.
  let bindings: ComponentBindings | null = null;
  let runtime: ClientRuntime;

  function ensureBindings(): ComponentBindings | null {
    if (!components) {
      return null;
    }
    if (bindings !== null) {
      return bindings;
    }
    const origin = componentOrigin ?? defaultComponentOrigin();
    if (origin === null) {
      return null;
    }
    bindings = createComponentBindings({
      document: scope.document as ComponentDocument,
      morph: (target, html) => runtime.morphComponent(target, html),
      islands: manager,
      origin,
      ...(componentFetch === undefined ? {} : { fetch: componentFetch }),
      ...(onError === undefined ? {} : { onError: (error) => onError(error) }),
    });
    return bindings;
  }

  function on(type: string, handler: (event: JsailsEvent) => void): void {
    scope.document.addEventListener(type, handler);
    listeners.push([type, handler]);
  }

  function notifyBeforeNavigation(detail: BeforeNavigationDetail): void {
    onBeforeNavigation?.(detail);
    scope.document.dispatchEvent(
      scope.createEvent(JSAILS_BEFORE_NAVIGATION, detail, { cancelable: true }),
    );
  }

  /** Refresh the island and component sets: drop removed, then bind new markup. */
  function refresh(): void {
    manager.collectRemoved();
    manager.mountAll();
    bindings?.collectRemoved();
    bindings?.mountAll();
  }

  function refreshFrame(event: JsailsEvent): void {
    const frame = event.target;
    if (frame !== null) {
      manager.mountWithin(frame);
    }
  }

  /**
   * Intercept a missing frame that JSails owns: mark the event handled (so
   * Turbo does not throw its uncaught `TurboFrameMissingError`) and show a
   * generic message. The raw server response is never read into the DOM.
   */
  function handleFrameMissing(event: JsailsEvent): void {
    const frame = event.target;
    if (frame === null || !frame.hasAttribute(ISLAND_ATTRIBUTE)) {
      return;
    }
    event.preventDefault();
    frame.textContent = FRAME_MISSING_MESSAGE;
  }

  /**
   * Register the Turbo lifecycle wiring exactly once. Done eagerly at
   * construction (existing consumers inspect the wiring without starting) and
   * re-done by `start` after a failed attempt has torn the listeners down.
   */
  function wireListeners(): void {
    if (wired) {
      return;
    }
    wired = true;

    on('turbo:before-cache', () => {
      // Abort in-flight component work before Turbo snapshots the DOM, so a
      // cached page never carries a controller whose request is still pending.
      bindings?.disposeAll();
      manager.unmountNonPermanent();
    });

    on('turbo:visit', (event) => {
      const detail = event.detail as { url?: string; action?: string } | undefined;
      lastVisit = { url: detail?.url, action: detail?.action };
    });

    on('turbo:before-render', (event) => {
      // Idempotent safety net: covers paths where `turbo:before-cache` did not
      // run (e.g. a page-refresh morph), so no non-permanent root stays mounted
      // and no component request stays in flight across a render Turbo owns.
      bindings?.disposeAll();
      manager.unmountNonPermanent();
      const detail = event.detail as { renderMethod?: string; isPreview?: boolean } | undefined;
      notifyBeforeNavigation({
        url: lastVisit.url,
        action: lastVisit.action,
        renderMethod: detail?.renderMethod,
        isPreview: detail?.isPreview,
      });
    });

    on('turbo:render', () => {
      refresh();
    });

    on('turbo:load', () => {
      refresh();
    });

    on('turbo:frame-load', refreshFrame);

    on('turbo:frame-render', refreshFrame);

    on('turbo:frame-missing', handleFrameMissing);
  }

  wireListeners();

  /**
   * Tear down everything a (possibly partially constructed) runtime owns:
   * dispose live component controllers, unmount islands hydrated before the
   * failure, remove every document listener, and drop the Turbo reference. It
   * clears `started` so a failed `start` can be retried on the same runtime;
   * `close` calls it after marking the runtime permanently closed.
   */
  function teardown(): void {
    bindings?.disposeAll();
    bindings = null;
    manager.unmountNonPermanent();
    for (const [type, handler] of listeners) {
      scope.document.removeEventListener(type, handler);
    }
    listeners.length = 0;
    wired = false;
    turbo = null;
    started = false;
  }

  runtime = {
    get started() {
      return started;
    },
    get bindings() {
      return bindings;
    },
    async start(): Promise<void> {
      if (started || closed) {
        return;
      }
      started = true;
      // Re-arm the lifecycle wiring if a previous failed attempt tore it down.
      wireListeners();
      try {
        turbo = await loadTurbo();
        turbo.start();
        // Initial hydration: also serves a plain static page with no Turbo
        // navigation (the same public API hydrates initial island markup).
        manager.mountAll();
        // Bindings are enabled after navigation init, so the delegated handlers
        // and the initial component roots are live before the first interaction.
        ensureBindings()?.mountAll();
      } catch (error) {
        // A failed startup must not leak listeners, island roots, or component
        // controllers, and must leave the runtime retryable. Preserve the
        // original error (never wrap it) and never assume a global Turbo
        // engine can be uninstalled.
        teardown();
        throw error;
      }
    },
    async morphComponent(target, html, options = {}): Promise<void> {
      const action = options.action ?? 'replace';
      const timeoutMs = options.timeoutMs ?? MORPH_RENDER_TIMEOUT_MS;
      const active = turbo ?? (await loadTurbo());
      await renderMorphAndAwait(scope.document, active, target, html, action, timeoutMs);
    },
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      teardown();
    },
  };
  return runtime;
}

let startPromise: Promise<void> | null = null;

/**
 * Start the browser runtime: dynamically load Turbo, start the shared session,
 * register any `islands`, hydrate the initial island markup, and auto-enable
 * the component bindings (unless `components: false`).
 *
 * Idempotent: repeated calls (sequential or concurrent) resolve the same
 * startup, and a second call after a successful start is a no-op. A failed
 * start clears the guard so a corrected call can retry.
 */
export function startClient(options: StartClientOptions = {}): Promise<void> {
  if (startPromise !== null) {
    return startPromise;
  }
  startPromise = (async () => {
    const runtime = createClientRuntime({ ...options, scope: defaultScope() });
    await runtime.start();
  })().catch((error: unknown) => {
    startPromise = null;
    throw error;
  });
  return startPromise;
}

/**
 * Morph server-rendered content into `target` in place, via a Turbo stream
 * message, and resolve once the morph has actually rendered. See
 * {@link MorphComponentOptions} for `update` vs `replace` semantics.
 */
export async function morphComponent(
  target: string,
  html: string,
  options: MorphComponentOptions = {},
): Promise<void> {
  const action = options.action ?? 'replace';
  const timeoutMs = options.timeoutMs ?? MORPH_RENDER_TIMEOUT_MS;
  const turbo = await defaultLoadTurbo();
  const scope = defaultScope();
  await renderMorphAndAwait(scope.document, turbo, target, html, action, timeoutMs);
}
