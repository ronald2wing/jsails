/**
 * Per-job middleware: a worker-side seam for cross-cutting behavior (logging,
 * metrics, and, in a later slice, batching/chaining). Middleware wraps the job
 * handler in declared order, outermost first — the same composition discipline
 * as Hono route middleware.
 *
 * The middleware context carries a `dispatch` function so a middleware can
 * enqueue follow-up work from the worker side. `JobContext` deliberately has no
 * runtime access, so this is the only worker-side seam that can drive the queue.
 */

/**
 * Context available to every middleware in the chain. The `dispatch` function
 * calls the runtime's own dispatch, so payloads are validated and the closed
 * state is enforced identically to the public API.
 */
export interface JobMiddlewareContext {
  /** Job name, matching the registry key. */
  readonly name: string;
  /** BullMQ job id, when one was assigned. */
  readonly jobId: string | undefined;
  /** Enqueue another job from within a middleware (worker side). */
  dispatch(name: string, payload: unknown, opts?: unknown): Promise<unknown>;
  /**
   * Raw dispatch options as passed to the producer. Framework-level features
   * such as job chaining read reserved keys from here. Undefined when the
   * adapter did not surface them.
   */
  readonly options: unknown;
}

/**
 * A job middleware: receives the validated payload, a middleware context, and a
 * `next` function to call the next middleware (or the handler). Return without
 * calling `next()` to short-circuit the chain; the resolved value becomes the
 * job result.
 */
export type JobMiddleware = (
  data: unknown,
  context: JobMiddlewareContext,
  next: () => Promise<unknown>,
) => Promise<unknown>;

/**
 * Raised for an invalid middleware shape or when `next()` is called more than once.
 * Messages are value-free — they never echo payloads or context values.
 */
export class JobMiddlewareError extends Error {
  readonly code: 'invalid_middleware' | 'middleware_threw';

  constructor(code: 'invalid_middleware' | 'middleware_threw') {
    super(code);
    this.name = 'JobMiddlewareError';
    this.code = code;
  }
}

/**
 * Compose a middleware array around a terminal handler. Each middleware
 * receives `(data, context, next)` where `next()` delegates to the next
 * middleware in the chain:
 *
 * - `[a, b]` → a calls next() → b calls next() → handler. Declared order,
 *   outermost first.
 * - A middleware that returns without calling `next()` short-circuits; its
 *   resolved value is the job result.
 * - `next()` is callable at most once; a second call throws.
 * - Handler and middleware errors propagate unwrapped to the caller.
 */
export function composeMiddleware(
  middleware: readonly JobMiddleware[],
  handler: (data: unknown, context: JobMiddlewareContext) => Promise<unknown>,
): (data: unknown, context: JobMiddlewareContext) => Promise<unknown> {
  if (middleware.length === 0) {
    return handler;
  }
  // Build the chain from innermost to outermost: start with the terminal
  // handler and wrap each middleware around it in reverse order so that
  // middleware[0] is the outermost wrapper.
  let composed = handler;
  for (let i = middleware.length - 1; i >= 0; i--) {
    const mw = middleware[i]!;
    const inner = composed;
    composed = (data, ctx) => {
      let called = false;
      const next = async (): Promise<unknown> => {
        if (called) {
          throw new JobMiddlewareError('middleware_threw');
        }
        called = true;
        return inner(data, ctx);
      };
      return mw(data, ctx, next);
    };
  }
  return composed;
}
