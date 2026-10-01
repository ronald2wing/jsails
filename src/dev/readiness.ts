/**
 * Bounded readiness waiter for a `PORT=0` dev server.
 *
 * The dev toolchain restarts the serve child when the tsc-watch initial emit
 * lands, so the first `Serving at` URL it prints can already be dead by the time
 * a client connects. This module waits for the *latest* observed URL to become
 * live instead of trusting the first one: it keeps watching for new URLs
 * through a bounded quiescence window (no new URL for `quiescenceMs`), then
 * probes that latest URL for a 2xx response, all within a single overall budget
 * (`timeoutMs`). It never retries without a deadline, and it consumes every URL
 * observed up to the resolved one, so a caller that waits for the next restart
 * after an edit is never handed a stale URL from an earlier burst.
 */

interface ReadinessClock {
  now(): number;
  delay(ms: number): Promise<void>;
}

export interface ReadinessOptions {
  /** Quiet period required (no new URL) before the latest URL is probed. */
  quiescenceMs: number;
  /** Pause between polls of the URL stream and between liveness probes. */
  pollIntervalMs: number;
  /** Inject time/sleep; defaults to `Date.now` / `setTimeout`. */
  clock?: ReadinessClock;
  /** Probe a URL for liveness; defaults to a bounded `fetch` accepting 2xx. */
  probe?: (url: string) => Promise<boolean>;
}

interface WaitForLiveOptions {
  /** Overall budget for a single wait; rejects with {@link DevReadinessError} when exceeded. */
  timeoutMs: number;
  /** Optional predicate; when it turns true the wait rejects immediately (process exit). */
  aborted?: () => boolean;
}

interface LiveUrl {
  /** The latest URL confirmed live after quiescence. */
  url: string;
  /** Number of URLs consumed up to and including the resolved one. */
  delivered: number;
}

/** Raised when the bounded wait ends without a live URL (timeout or process exit). */
export class DevReadinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevReadinessError';
  }
}

const defaultClock: ReadinessClock = {
  now: () => Date.now(),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A liveness probe bounded by its own abort timer so a half-open port never hangs. */
function defaultProbe(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  return fetch(url, { signal: controller.signal })
    .then((response) => response.ok)
    .catch(() => false)
    .finally(() => clearTimeout(timer));
}

export class DevUrlTracker {
  private readonly urls: string[] = [];
  private delivered = 0;
  private readonly clock: ReadinessClock;
  private readonly probe: (url: string) => Promise<boolean>;
  private readonly quiescenceMs: number;
  private readonly pollIntervalMs: number;

  constructor(options: ReadinessOptions) {
    this.quiescenceMs = options.quiescenceMs;
    this.pollIntervalMs = options.pollIntervalMs;
    this.clock = options.clock ?? defaultClock;
    this.probe = options.probe ?? defaultProbe;
  }

  /** Record a newly-observed serving URL. */
  noteUrl(url: string): void {
    this.urls.push(url);
  }

  /**
   * Wait for the next URL (after everything already delivered) to settle and
   * answer a 2xx probe. When it resolves, every URL observed up to that point
   * has been consumed, so a subsequent call only ever waits for a genuinely new
   * URL. Rejects on timeout or when `aborted()` turns true.
   */
  async waitForLive(options: WaitForLiveOptions): Promise<LiveUrl> {
    const deadline = this.clock.now() + options.timeoutMs;
    let lastSeen = this.urls.length;
    let quietSince = this.clock.now();

    for (;;) {
      if (options.aborted?.()) {
        throw new DevReadinessError(
          'the dev process exited before a live Serving URL was confirmed',
        );
      }
      if (this.clock.now() > deadline) {
        throw new DevReadinessError(
          `timed out after ${options.timeoutMs} ms waiting for a live Serving URL ` +
            `(${this.urls.length} observed)`,
        );
      }

      const count = this.urls.length;
      if (count !== lastSeen) {
        lastSeen = count;
        quietSince = this.clock.now();
      }

      if (count > this.delivered && this.clock.now() - quietSince >= this.quiescenceMs) {
        const latest = this.urls[count - 1];
        if (latest !== undefined && (await this.probe(latest))) {
          this.delivered = count;
          return { url: latest, delivered: count };
        }
      }

      await this.clock.delay(this.pollIntervalMs);
    }
  }
}
