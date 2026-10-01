/**
 * Hotwire Native web groundwork — protocol slice.
 *
 * Bridge message envelope + reply channel, bridge-component name registry with
 * lifecycle dispatch, and the typed visit-proposal contract that a native shell
 * consumes. All types and builders are pure and browser-safe (no `node:*`
 * imports).
 *
 * This module extends the existing static slice in {@link ./native.ts} with the
 * stateful, protocol-level surface the roadmap identifies as the gap.
 */

// ---------------------------------------------------------------------------
// Bridge message envelope
// ---------------------------------------------------------------------------

/**
 * A Hotwire-Native-style bridge message.
 *
 * Every message carries a unique {@link id} for request/reply correlation and a
 * required {@link event} name. The optional {@link component} scopes the
 * message to a registered native component, and {@link data} is the
 * unstructured payload.
 */
export interface BridgeMessage {
  readonly id: string;
  readonly component?: string;
  readonly event: string;
  readonly data: unknown;
  readonly metadata?: { readonly url?: string };
}

/**
 * Value-free error raised by the bridge-message builders for structurally
 * invalid input. The message carries only diagnostics, never the raw input.
 */
export class BridgeMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeMessageError';
  }
}

/**
 * Construct a {@link BridgeMessage}.
 *
 * `id` defaults to a random UUID when not supplied. Use an injectable id for
 * deterministic correlation in tests.
 */
export function createBridgeMessage(
  component: string | undefined,
  event: string,
  data: unknown,
  options?: { readonly metadata?: { readonly url?: string }; readonly id?: string },
): BridgeMessage {
  if (event.length === 0) {
    throw new BridgeMessageError('bridge message event must be a non-empty string');
  }

  const id = options?.id ?? generateId();

  if (id.length === 0) {
    throw new BridgeMessageError('bridge message id must be a non-empty string');
  }

  const message: BridgeMessage = {
    id,
    component,
    event,
    data,
    ...(options?.metadata !== undefined ? { metadata: options.metadata } : {}),
  };

  return message;
}

/**
 * Build a reply to `original`, keeping the same id for correlation.
 *
 * Returns a new {@link BridgeMessage} whose `id` equals `original.id`. When
 * `data` is omitted the reply carries `null`.
 */
export function replyTo(original: BridgeMessage, event: string, data?: unknown): BridgeMessage {
  return createBridgeMessage(undefined, event, data ?? null, {
    id: original.id,
  });
}

/**
 * Structural guard: returns `true` when `value` is a minimally valid
 * {@link BridgeMessage} object. Checks only the required shape keys, not
 * property types.
 */
export function isBridgeMessage(value: unknown): value is BridgeMessage {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj.id === 'string' && typeof obj.event === 'string' && 'data' in obj;
}

/**
 * Generate a random UUID for message ids.
 *
 * Uses `globalThis.crypto.randomUUID()` when available; falls back to a
 * timestamp-plus-random suffix for very old environments.
 */
function generateId(): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }

  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${ts}-${rand}`;
}

// ---------------------------------------------------------------------------
// Bridge component registry
// ---------------------------------------------------------------------------

/**
 * Value-free error raised by the bridge-component registry for invalid
 * operations (duplicate register, unknown unregister). Messages never echo
 * the raw component name.
 */
export class BridgeComponentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeComponentError';
  }
}

/**
 * A name-based registry for native bridge components.
 *
 * {@link register} and {@link unregister} automatically dispatch lifecycle
 * messages through the injectable `send` callback; {@link has} and
 * {@link names} are read-only introspection methods.
 */
export interface BridgeComponentRegistry {
  /** Register a component name. Dispatches a `register` event through `send`. */
  register(name: string): void;

  /** Unregister a component name. Dispatches an `unregister` event through `send`. */
  unregister(name: string): void;

  /** Returns `true` when the name is currently registered. */
  has(name: string): boolean;

  /** Returns a frozen snapshot of every registered component name. */
  names(): readonly string[];
}

/**
 * Create a bridge-component name registry.
 *
 * `send` is an injectable message dispatch callback. The returned registry is
 * self-contained — it owns its name set and never accesses `window` or any
 * global state.
 */
export function createBridgeComponentRegistry(
  send: (message: BridgeMessage) => void,
): BridgeComponentRegistry {
  const registered = new Set<string>();

  const registry: BridgeComponentRegistry = {
    register(name: string) {
      if (name.length === 0) {
        throw new BridgeComponentError('component name must be a non-empty string');
      }
      if (registered.has(name)) {
        throw new BridgeComponentError('component is already registered');
      }
      registered.add(name);
      send(createBridgeMessage(name, 'register', null));
    },

    unregister(name: string) {
      if (!registered.has(name)) {
        throw new BridgeComponentError('component is not registered');
      }
      registered.delete(name);
      send(createBridgeMessage(name, 'unregister', null));
    },

    has(name: string): boolean {
      return registered.has(name);
    },

    names(): readonly string[] {
      return Object.freeze([...registered]);
    },
  };

  return registry;
}

// ---------------------------------------------------------------------------
// Visit proposal contract
// ---------------------------------------------------------------------------

/**
 * The navigation action the native shell proposes.
 *
 * - `advance` — a standard forward navigation (push onto the stack).
 * - `replace` — replace the current entry on the stack.
 * - `restore` — restore a previously-cached page state.
 */
export type VisitProposalAction = 'advance' | 'replace' | 'restore';

const VALID_ACTIONS: ReadonlySet<string> = new Set(['advance', 'replace', 'restore']);

/**
 * A native-shell visit proposal.
 *
 * The shell sends this to signal an imminent navigation so the web runtime can
 * drop in-flight work. The {@link onBeforeNavigation} seam and
 * `jsails:before-navigation` document event are the web-side consumers.
 */
export interface VisitProposal {
  readonly location: string;
  readonly options: {
    readonly action: VisitProposalAction;
    readonly response?: unknown;
  };
}

/**
 * Structural guard: returns `true` when `value` is a minimally valid
 * {@link VisitProposal} object. Accepts only the three known actions; the
 * `response` field is optional and never inspected.
 */
export function isVisitProposal(value: unknown): value is VisitProposal {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const obj = value as Record<string, unknown>;

  if (typeof obj.location !== 'string') {
    return false;
  }

  const options = obj.options;
  if (options === null || typeof options !== 'object') {
    return false;
  }

  const opts = options as Record<string, unknown>;
  const action = opts.action;

  return typeof action === 'string' && VALID_ACTIONS.has(action);
}
