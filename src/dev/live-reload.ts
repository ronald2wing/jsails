/**
 * Dev live-reload — auto-refresh the browser when the dev server restarts.
 *
 * The honest HMR for a nodemon-restarting SSR stack is not state-preserving
 * module replacement (which requires a Vite dev server + module graph), it is
 * **reload-on-restart**: an SSE stream the server serves under
 * `/_jsails/dev/reload` that the browser subscribes to in development. When
 * nodemon kills and restarts the serve child, the SSE stream drops, and the
 * client — on reconnecting successfully — reloads the page once.
 *
 * This module is server-only and dev-only. It is never mounted in production.
 */

/**
 * The inline `<script>` the starter injects into `<head>` in development. It
 * opens an EventSource to `/_jsails/dev/reload` and reloads the page exactly
 * once on each reconnection after a drop (the "server restarted" signal).
 */
export function devReloadScript(): string {
  return `(function () {
  var url = '/_jsails/dev/reload';
  var es;
  function connect() {
    es = new EventSource(url);
    // A successful (re)connect after a disconnect means the server restarted.
    es.addEventListener('open', function () {
      if (es.__jsailsWarmed) { es.__jsailsWarmed = false; location.reload(); }
      else { es.__jsailsWarmed = true; }
    }, { once: false });
    es.onerror = function () { es.close(); setTimeout(connect, 500); };
  }
  connect();
})();`;
}

/** A single shared SSE "channel": server-sent `retry` keeps the client subscribed. */
const SSE_HEARTBEAT = `event: open\ndata: {}\n\n`;

/** Options for {@link liveReloadResponse}. */
export interface LiveReloadOptions {
  /** Emit a `retry` hint so the client probes again after `retryMs`. Default 1000. */
  readonly retryMs?: number;
}

/**
 * A `Response` streaming the reload channel. Use as the handler for the
 * `GET /_jsails/dev/reload` route; the connection stays open until the client
 * or server drops it. On drop the server restarts and a fresh connection
 * signals "reload".
 */
export function liveReloadResponse(options: LiveReloadOptions = {}): Response {
  const retryMs = options.retryMs ?? 1000;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(`retry: ${retryMs}\n\n`));
      timer = setInterval(() => {
        controller.enqueue(encoder.encode(SSE_HEARTBEAT));
      }, 15000);
    },
    cancel() {
      // The stream was closed (browser navigated away, or a test cancelled).
      // Clear the heartbeat so the event loop can drain; on a real restart the
      // process exits anyway.
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    },
  });
}
