/**
 * The shutdown signal seam shared by the runtime (`work`), app (`serve`), and
 * `create` commands. Extracted so the command modules can wait for
 * SIGINT/SIGTERM without importing back from `cli.ts`.
 */

/** The shutdown wait seam: a promise plus a disposer removing signal listeners. */
export interface ShutdownSignal {
  readonly promise: Promise<void>;
  dispose(): void;
}

/**
 * Install SIGINT/SIGTERM handlers that resolve on the first signal. `dispose()`
 * removes the listeners so a startup failure or completed shutdown never leaks
 * a signal handler. The handlers are installed before the worker starts so a
 * SIGINT/SIGTERM can interrupt the worker's startup connection retries.
 */
export function waitForShutdownSignal(): ShutdownSignal {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  const listeners: Array<[NodeJS.Signals, () => void]> = [];
  for (const signal of signals) {
    const listener = () => resolvePromise();
    process.on(signal, listener);
    listeners.push([signal, listener]);
  }
  let disposed = false;
  return {
    promise,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const [signal, listener] of listeners) {
        process.removeListener(signal, listener);
      }
    },
  };
}
