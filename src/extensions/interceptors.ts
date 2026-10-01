/**
 * Interceptors and observers: identity-based extension points for modules.
 *
 * An operation token ({@link defineOperation}) names a point a plugin may hook
 * "before" or "after"; an event token ({@link defineEvent}) names a broadcast a
 * plugin may observe. Tokens are identity-based like service tokens: the token
 * object itself is the lookup key, so two tokens created with the same name
 * remain distinct. A runtime marker distinguishes a real operation/event token
 * from an arbitrary object, so an unknown token is rejected rather than quietly
 * matched.
 *
 * Token {@code name} is also a registrable alias resolved through the
 * framework-owned name→token registry ({@link resolveOperation},
 * {@link resolveEvent}). A plugin can hook by name without importing the token
 * object, and a typo fails loudly at registration (setup time) rather than
 * silently. Identity semantics are unchanged: the token object is still the
 * key, and two same-named tokens remain distinct objects.
 *
 * A registry ({@link createInterceptorRegistry}) is created by the extension
 * runner per application and handed to each module's `setup` through the
 * module context. Registration is valid only while `setup` runs — the registry
 * is sealed afterwards and there is no removal API. Invocation is exposed for
 * the framework and for tests through `runBefore` / `runAfter` / `emit`.
 *
 * Exact semantics, by phase:
 *
 * - `before`: `fn(args, ctx) => void | Promise<void>` — ascending priority, then
 *   declaration order; awaited sequentially; in-place mutation only; no
 *   short-circuit (throw to abort).
 * - `after`: `fn(result, args, ctx) => result | Promise<result>` — reverse
 *   order; may transform the result; errors propagate.
 * - `observe`: `fn(payload, ctx) => void | Promise<void>` — ascending order;
 *   errors isolated and collected; no transform.
 *
 * There is deliberately no general `around` hook.
 */

const operationKind: unique symbol = Symbol('jsails.operation');
const eventKind: unique symbol = Symbol('jsails.event');

/**
 * An opaque handle to an interception point with argument type `TArgs` and
 * result type `TResult`. Identity is the object, not the name.
 */
export interface OperationToken<TArgs = unknown, TResult = unknown> {
  /** Registrable alias resolved through the name→token registry. */
  readonly name: string;
  /** Runtime marker; phantom `args`/`result` slots are never present at runtime. */
  readonly [operationKind]: { args: TArgs; result: TResult };
}

/** An opaque handle to an observed event carrying payload type `TPayload`. */
export interface EventToken<TPayload = unknown> {
  /** Registrable alias resolved through the name→token registry. */
  readonly name: string;
  /** Runtime marker; the phantom payload slot is never present at runtime. */
  readonly [eventKind]: TPayload;
}

// --- name→token registry (module-level, framework-owned) ---

/**
 * First-registered token per operation name. Used by {@link resolveOperation}
 * and {@link lookupOperation} for bare resolution. Later duplicates do NOT
 * replace the first entry and are kept in {@link allOperationsByName} only.
 */
const operationByName = new Map<string, OperationToken<unknown, unknown>>();

/**
 * All registered operation tokens per name (including duplicates). Kept so a
 * later wave can resolve collisions through namespace-qualified lookup.
 */
const allOperationsByName = new Map<string, OperationToken<unknown, unknown>[]>();

/**
 * First-registered token per event name. Used by {@link resolveEvent} and
 * {@link lookupEvent} for bare resolution. Later duplicates do NOT replace the
 * first entry and are kept in {@link allEventsByName} only.
 */
const eventByName = new Map<string, EventToken<unknown>>();

/**
 * All registered event tokens per name (including duplicates). Kept so a later
 * wave can resolve collisions through namespace-qualified lookup.
 */
const allEventsByName = new Map<string, EventToken<unknown>[]>();

/**
 * Resolve an operation name to the first-registered token.
 *
 * Throws {@link InterceptorError} with code `'unknown_operation'` when no token
 * is registered under `name`. The error message never echoes the input name.
 */
export function resolveOperation(name: string): OperationToken<unknown, unknown> {
  const token = operationByName.get(name);
  if (!token) {
    throw new InterceptorError('unknown_operation', 'unknown operation');
  }
  return token;
}

/**
 * Look up an operation name, returning `undefined` when no token is registered
 * under `name` instead of throwing.
 */
export function lookupOperation(name: string): OperationToken<unknown, unknown> | undefined {
  return operationByName.get(name);
}

/**
 * Resolve an event name to the first-registered token.
 *
 * Throws {@link InterceptorError} with code `'unknown_event'` when no token is
 * registered under `name`. The error message never echoes the input name.
 */
export function resolveEvent(name: string): EventToken<unknown> {
  const token = eventByName.get(name);
  if (!token) {
    throw new InterceptorError('unknown_event', 'unknown event');
  }
  return token;
}

/**
 * Look up an event name, returning `undefined` when no token is registered
 * under `name` instead of throwing.
 */
export function lookupEvent(name: string): EventToken<unknown> | undefined {
  return eventByName.get(name);
}

// --- token factories ---

/**
 * Create a new operation token and register it in the name→token registry.
 *
 * Each call produces a distinct identity even when `name` repeats; the registry
 * keeps the first token for bare resolution and stores every token for later
 * collision handling.
 */
export function defineOperation<TArgs = unknown, TResult = unknown>(
  name: string,
): OperationToken<TArgs, TResult> {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('operation token name must be a non-empty string');
  }
  const token = { name, [operationKind]: true } as unknown as OperationToken<TArgs, TResult>;
  const bare = token as OperationToken<unknown, unknown>;

  const existing = operationByName.get(name);
  if (!existing) {
    operationByName.set(name, bare);
  }

  const all = allOperationsByName.get(name) ?? [];
  all.push(bare);
  allOperationsByName.set(name, all);

  return token;
}

/**
 * Create a new event token and register it in the name→token registry.
 *
 * Each call produces a distinct identity even when `name` repeats; the registry
 * keeps the first token for bare resolution and stores every token for later
 * collision handling.
 */
export function defineEvent<TPayload = unknown>(name: string): EventToken<TPayload> {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('event token name must be a non-empty string');
  }
  const token = { name, [eventKind]: true } as unknown as EventToken<TPayload>;

  const existing = eventByName.get(name);
  if (!existing) {
    eventByName.set(name, token);
  }

  const all = allEventsByName.get(name) ?? [];
  all.push(token);
  allEventsByName.set(name, all);

  return token;
}

/** Context handed to every interceptor and observer callback. */
export interface InterceptorContext {
  /** Name of the module whose hook is running, when registered through one. */
  readonly moduleName: string | undefined;
}

/** A "before" hook: runs before the operation, mutating `args` in place. */
export type BeforeInterceptor<TArgs = unknown> = (
  args: TArgs,
  context: InterceptorContext,
) => void | Promise<void>;

/** An "after" hook: runs after the operation, transforming `result`. */
export type AfterInterceptor<TArgs = unknown, TResult = unknown> = (
  result: TResult,
  args: TArgs,
  context: InterceptorContext,
) => TResult | Promise<TResult>;

/** An observer: reacts to an emitted event payload without transforming it. */
export type Observer<TPayload = unknown> = (
  payload: TPayload,
  context: InterceptorContext,
) => void | Promise<void>;

/** Which interceptor phase a hook registers for. */
export type InterceptorPhase = 'before' | 'after';

/** Options for {@link InterceptorRegistry.intercept}. */
export interface InterceptOptions {
  /** Which phase to register; defaults to `'before'`. */
  readonly phase?: InterceptorPhase;
  /** Ordering key; defaults to `0`, lower runs first. */
  readonly priority?: number;
  /** Diagnostic module name carried into the callback context. */
  readonly moduleName?: string;
}

/** Options for {@link InterceptorRegistry.observe}. */
export interface ObserveOptions {
  /** Ordering key; defaults to `0`, lower runs first. */
  readonly priority?: number;
  /** Diagnostic module name carried into the callback context. */
  readonly moduleName?: string;
}

/** Machine-readable failure reason for {@link InterceptorError}. */
export type InterceptorErrorCode = 'unknown_operation' | 'unknown_event' | 'sealed';

/** Raised for every interceptor-registry invariant (unknown token, late registration). */
export class InterceptorError extends Error {
  readonly code: InterceptorErrorCode;

  constructor(code: InterceptorErrorCode, message: string) {
    super(message);
    this.name = 'InterceptorError';
    this.code = code;
  }
}

/**
 * A per-application interceptor/observer registry. Registration methods are
 * sealed after setup; invocation methods stay available for the framework and
 * for tests.
 *
 * {@link intercept} and {@link observe} accept either a token object (identity
 * remains the lookup key) or a name string resolved through the name→token
 * registry at registration time. An unknown name throws an
 * {@link InterceptorError} at registration — never silence.
 */
export interface InterceptorRegistry {
  /**
   * Register a before/after hook for `operation`. Pass a token object or a
   * name string resolved through the name→token registry at registration time.
   * Only valid before {@link seal}.
   */
  intercept<TArgs = unknown, TResult = unknown>(
    operation: OperationToken<TArgs, TResult> | string,
    fn: BeforeInterceptor<TArgs> | AfterInterceptor<TArgs, TResult>,
    options?: InterceptOptions,
  ): void;
  /**
   * Register an observer for `event`. Pass a token object or a name string
   * resolved through the name→token registry at registration time.
   * Only valid before {@link seal}.
   */
  observe<TPayload = unknown>(
    event: EventToken<TPayload> | string,
    fn: Observer<TPayload>,
    options?: ObserveOptions,
  ): void;
  /** Run every before hook for `operation` in ascending order; throw aborts. */
  runBefore<TArgs = unknown>(operation: OperationToken<TArgs, unknown>, args: TArgs): Promise<void>;
  /** Run every after hook for `operation` in reverse, threading `initialResult`. */
  runAfter<TArgs = unknown, TResult = unknown>(
    operation: OperationToken<TArgs, TResult>,
    args: TArgs,
    initialResult: TResult,
  ): Promise<TResult>;
  /** Run every observer for `event` in ascending order, collecting errors. */
  emit<TPayload = unknown>(
    event: EventToken<TPayload>,
    payload: TPayload,
  ): Promise<readonly unknown[]>;
  /** Stop future registration; idempotent. Invocation still works afterwards. */
  seal(): void;
}

interface OrderedHook {
  readonly fn: (...args: unknown[]) => unknown;
  readonly priority: number;
  readonly index: number;
  readonly moduleName: string | undefined;
}

function isOperationToken(value: unknown): value is OperationToken<unknown, unknown> {
  if (value === null || typeof value !== 'object') return false;
  return (value as { [operationKind]?: unknown })[operationKind] === true;
}

function isEventToken(value: unknown): value is EventToken<unknown> {
  if (value === null || typeof value !== 'object') return false;
  return (value as { [eventKind]?: unknown })[eventKind] === true;
}

function requireOperation(value: unknown): OperationToken<unknown, unknown> {
  if (!isOperationToken(value)) {
    throw new InterceptorError('unknown_operation', 'not an operation token');
  }
  return value;
}

function requireEvent(value: unknown): EventToken<unknown> {
  if (!isEventToken(value)) {
    throw new InterceptorError('unknown_event', 'not an event token');
  }
  return value;
}

function requireHook(fn: unknown): void {
  if (typeof fn !== 'function') {
    throw new TypeError('interceptor and observer callbacks must be functions');
  }
}

function resolvePriority(value: number | undefined): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('interceptor priority must be a finite number');
  }
  return value;
}

/** Ascending priority, then declaration order (the "before" / "observe" order). */
function ascending(left: OrderedHook, right: OrderedHook): number {
  return left.priority - right.priority || left.index - right.index;
}

/** Descending priority, then declaration order (the "after" order). */
function descending(left: OrderedHook, right: OrderedHook): number {
  return right.priority - left.priority || right.index - left.index;
}

/**
 * Create an isolated interceptor/observer registry. Registration is valid until
 * {@link InterceptorRegistry.seal}; there is no removal API, and unknown tokens
 * are rejected. Callers own `seal()` (the extension runner seals after setup).
 */
export function createInterceptorRegistry(): InterceptorRegistry {
  const before = new Map<OperationToken<unknown, unknown>, OrderedHook[]>();
  const after = new Map<OperationToken<unknown, unknown>, OrderedHook[]>();
  const observers = new Map<EventToken<unknown>, OrderedHook[]>();
  let sealed = false;
  let nextIndex = 0;

  const assertOpen = (): void => {
    if (sealed) {
      throw new InterceptorError(
        'sealed',
        'interceptors and observers can only be registered during setup',
      );
    }
  };

  const push = (
    bucket: Map<unknown, OrderedHook[]>,
    token: unknown,
    fn: unknown,
    priority: number,
    moduleName: string | undefined,
  ): void => {
    requireHook(fn);
    const list = bucket.get(token) ?? [];
    list.push({
      fn: fn as (...args: unknown[]) => unknown,
      priority,
      index: nextIndex,
      moduleName,
    });
    nextIndex += 1;
    bucket.set(token, list);
  };

  return {
    intercept(operation, fn, options) {
      assertOpen();
      const token =
        typeof operation === 'string' ? resolveOperation(operation) : requireOperation(operation);
      const priority = resolvePriority(options?.priority);
      const moduleName = options?.moduleName;
      push(options?.phase === 'after' ? after : before, token, fn, priority, moduleName);
    },
    observe(event, fn, options) {
      assertOpen();
      const token = typeof event === 'string' ? resolveEvent(event) : requireEvent(event);
      const priority = resolvePriority(options?.priority);
      const moduleName = options?.moduleName;
      push(observers, token, fn, priority, moduleName);
    },
    runBefore(operation, args) {
      const token = requireOperation(operation);
      const ordered = [...(before.get(token) ?? [])].sort(ascending);
      return (async () => {
        for (const hook of ordered) {
          await hook.fn(args, { moduleName: hook.moduleName });
        }
      })();
    },
    runAfter(operation, args, initialResult) {
      const token = requireOperation(operation);
      const ordered = [...(after.get(token) ?? [])].sort(descending);
      return (async () => {
        let result = initialResult;
        for (const hook of ordered) {
          result = (await hook.fn(result, args, {
            moduleName: hook.moduleName,
          })) as typeof result;
        }
        return result;
      })();
    },
    emit(event, payload) {
      const token = requireEvent(event);
      const ordered = [...(observers.get(token) ?? [])].sort(ascending);
      return (async () => {
        const errors: unknown[] = [];
        for (const hook of ordered) {
          try {
            await hook.fn(payload, { moduleName: hook.moduleName });
          } catch (error) {
            errors.push(error);
          }
        }
        return errors;
      })();
    },
    seal() {
      sealed = true;
    },
  };
}
