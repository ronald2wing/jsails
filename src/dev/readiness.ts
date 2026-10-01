/**
 * Dev-toolchain liveness probe, consumed by the starter-verification harness.
 *
 * `jsails dev` drives `tsc --watch` and Vite in watch mode, restarting the
 * backend with nodemon on every change. Because the app listens on an ephemeral
 * port (`PORT=0`), every restart prints a fresh `Serving at http://127.0.0.1:<n>/`
 * line, and a URL printed moments ago may already be dead by the time a client
 * connects — the tsc-watch initial emit alone triggers a benign restart. A
 * harness that handed out the first URL it saw would race the restart.
 *
 * This module is the harness's answer: a small state holder that records every
 * observed URL and only resolves the **latest** one once it has been stable for
 * a quiet period *and* answers a 2xx probe. It is a verification helper, not a
 * framework feature — it is imported by `scripts/verify-starter.mjs` only, never
 * by the runtime, and is not a public subpath.
 */

/** Value-free failure raised while probing a dev server for a live URL. */
export type DevUrlTrackerErrorCode = 'aborted' | 'timeout';

export class DevUrlTrackerError extends Error {
  readonly code: DevUrlTrackerErrorCode;

  constructor(code: DevUrlTrackerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DevUrlTrackerError';
    this.code = code;
  }
}

/** Options for {@link DevUrlTracker}. */
export interface DevUrlTrackerOptions {
  /** Quiet period (ms) with no new URL before the latest URL is probed. */
  readonly quiescenceMs: number;
  /** Poll interval (ms) between new-URL checks and liveness retries. */
  readonly pollIntervalMs: number;
}

/** A wait for a live URL, as passed to {@link DevUrlTracker.waitForLive}. */
export interface WaitForLiveOptions {
  /** Total budget for the wait before it rejects with {@link DevUrlTrackerError}. */
  readonly timeoutMs: number;
  /** Abort predicate: when true, the wait rejects instead of continuing to poll. */
  readonly aborted: () => boolean;
}

/**
 * Records dev-server URLs and resolves the latest one that is both quiescent
 * (no newer URL for {@link DevUrlTrackerOptions.quiescenceMs}) and live (a 2xx
 * answer on the probe path).
 */
export class DevUrlTracker {
  readonly #quiescenceMs: number;
  readonly #pollIntervalMs: number;

  #urls: readonly { url: string; notedAt: number }[] = [];
  #consumedCount = 0;
  #clock: () => number;
  #probe: (url: string) => Promise<boolean>;
  #sleep: (ms: number) => Promise<void>;

  constructor(
    options: DevUrlTrackerOptions,
    clock: () => number = Date.now,
    probe: (url: string) => Promise<boolean> = probeUrl,
    sleepFn: (ms: number) => Promise<void> = sleep,
  ) {
    this.#quiescenceMs = options.quiescenceMs;
    this.#pollIntervalMs = options.pollIntervalMs;
    this.#clock = clock;
    this.#probe = probe;
    this.#sleep = sleepFn;
  }

  /** Record a freshly observed `Serving at` URL. */
  noteUrl(url: string): void {
    this.#urls = [...this.#urls, { url, notedAt: this.#clock() }];
  }

  /**
   * Resolve to `{ url }` once the latest **not-yet-consumed** URL is both
   * quiescent and live, rejecting with {@link DevUrlTrackerError} on timeout or
   * abort.
   *
   * Each call consumes exactly one URL: the first call returns the first live
   * URL, the next call waits for a newer one (a restart printing a fresh port),
   * and so on. This is what lets the harness await each nodemon restart rather
   * than re-resolving the previous, still-live URL.
   *
   * The loop never hands out a URL observed less than `quiescenceMs` ago, and it
   * re-anchors to a newer URL whenever one is noted mid-wait — so a restart that
   * prints a fresh port while the harness holds the previous (now dead) URL is
   * waited out until the new port settles and answers.
   */
  async waitForLive(options: WaitForLiveOptions): Promise<{ url: string }> {
    const startedAt = this.#clock();

    while (true) {
      if (options.aborted()) {
        throw new DevUrlTrackerError(
          'aborted',
          'dev server exited before a live Serving URL was confirmed',
        );
      }
      if (this.#clock() - startedAt >= options.timeoutMs) {
        throw new DevUrlTrackerError(
          'timeout',
          `no live Serving URL within ${options.timeoutMs}ms`,
        );
      }

      const latestIndex = this.#urls.length - 1;
      const latest = this.#urls[latestIndex];
      const unseen = latestIndex >= this.#consumedCount;
      const quiescent =
        latest !== undefined && this.#clock() - latest.notedAt >= this.#quiescenceMs;

      if (latest !== undefined && unseen && quiescent && (await this.#probe(latest.url))) {
        this.#consumedCount = latestIndex + 1;
        return { url: latest.url };
      }

      await this.#sleep(this.#pollIntervalMs);
    }
  }
}

/** Answer whether `url` probes live (a 2xx response). */
async function probeUrl(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    return response.status >= 200 && response.status < 300;
  } catch {
    // Connection refused / reset is the expected state for a restarting server.
    return false;
  }
}

/** Resolve after `ms`; the polling backoff between probes. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
