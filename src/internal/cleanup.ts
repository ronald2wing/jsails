/**
 * Idempotent, concurrent-safe teardown wrapper.
 *
 * Dependency-free (no Node imports). Nothing here is re-exported from the
 * package entry (`src/index.ts`); the public surface is through
 * `jsails/extensions`.
 */

/**
 * Wrap a teardown function so it runs at most once. The first call starts the
 * teardown and memoizes its promise; every later call (including concurrent
 * ones) returns that same promise. A rejected teardown is memoized too, so a
 * retry does not re-run it — the caller observes the same rejection.
 */
export function createCleanup(teardown: () => void | Promise<void>): () => Promise<void> {
  let promise: Promise<void> | null = null;

  return () => {
    // Assign synchronously before any await so two concurrent calls share
    // exactly one invocation of `teardown`. A synchronous throw from `teardown`
    // is captured into the rejected promise; a rejected promise is memoized and
    // never retried, so every caller observes the same outcome.
    if (promise === null) {
      try {
        promise = Promise.resolve(teardown());
      } catch (error: unknown) {
        promise = Promise.reject(error);
      }
    }
    return promise;
  };
}
