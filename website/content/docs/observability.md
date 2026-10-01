---
title: Observability
order: 26
section: Reference
---

# Observability

Observability covers logging, signals, diagnostics, and the pluggable request,
query, and exception watchers.

JSails ships three value-free observability surfaces — a **record-first logging
service** (`jsails/logging`), a **signal bus** (`jsails/signals`), and a
**Telescope-style diagnostics recorder** (`jsails/diagnostics`) with pluggable
watchers. Each is inert at construction: nothing connects and nothing is
recorded or emitted until a method is called.

## Logging

`jsails/logging` is a record-first structured logging service. The record is the
API and the string is a rendering: `logger.info(msg, context?)` builds a frozen
`LogRecord { level, message, context, at }`, and each channel receives the
record.

```ts
import { RecordLogger, consoleChannel, jsonFormatter } from 'jsails/logging';

const logger = new RecordLogger({
  channels: [consoleChannel({ formatter: jsonFormatter() })],
});

logger.info('user signed in', { userId: 42 });
logger.error('payment failed', { orderId: 'ord_123' });
```

- **Levels** — `debug` | `info` | `warn` | `error`, ordered. Each channel
  carries its own `minLevel` threshold and receives only records at or above it.
- **Channels** are the pluggable seam (`{ name, minLevel, write(record) }`).
  Built-ins: `consoleChannel()` (default; `warn`/`error` → stderr, `debug`/`info`
  → stdout), `memoryChannel()` (tests; exposes raw `records()` and `clear()`),
  and `nullChannel()` (discard).
- **Formatters** are pluggable (`{ format(record) }`). Built-ins:
  `jsonFormatter()` (stable key order `level`/`message`/`context`/`at`) and
  `lineFormatter()` (`<ISO> <LEVEL> <message> <json context>`). Both never
  throw: a circular or `toJSON`-throwing value becomes `"[unserializable]"`, and
  functions/symbols/`undefined` are dropped.
- **`child(context)`** returns a logger whose bound context is merged into every
  record (child overrides parent; nested children merge in order). The bound
  context is copied, never mutated.

The logger itself never throws: a throwing channel or sink never propagates to
the caller. `LoggerError` (`invalid_level` / `unknown_channel` /
`invalid_options`) is value-free.

### Plugin

`loggerPlugin(options?)` provides a `Logger` under the typed `loggerToken`
service. An optional `diagnostics` recorder receives a value-free
`{ type: 'log', data: { level, message } }` entry on every call (the record's
`context` is deliberately excluded), and an optional `signals` bus emits the
shared `logError` event for `error`-level records. Both sinks are
failure-isolated.

```js
// jsails.app.js  (app-owned; plain ESM, compiled JS)
import { loggerPlugin } from 'jsails/logging';

export default {
  plugins: {
    use: ['jsails/logging'],
  },
};
```

## Signals

`jsails/signals` is a service-layer **signal bus** over the shared
interceptor/observer registry. `new RegistrySignalBus(registry)` wraps an
`InterceptorRegistry` as a `SignalBus` (`observe`/`emit`); `signalsPlugin()`
exposes that bus under the typed `signalsToken` service.

```js
// jsails.app.js  (app-owned; plain ESM, compiled JS)
import { signalsPlugin } from 'jsails/signals';

export default {
  plugins: {
    use: ['jsails/signals'],
  },
};
```

The bus adds no buffering, durability, or removal API — it delegates to the
registry, whose seal guard applies: registration closes after `setup`, while
`emit` stays callable. `emit` isolates observer errors — it never throws and
resolves to a `readonly unknown[]` of the errors thrown by observers. Because
the bus is the **shared** registry, an observer registered by one plugin fires
for events emitted by another.

`requestStarted` / `requestFinished` / `requestFailed` are built-in lifecycle
events emitted by the API pipeline when the signals plugin is enabled. Their
`RequestSignalPayload` is value-free: it carries the `Request`, `URL`, params,
method, route, and `session` (server-only), but never the body, headers, or
cookies. Emission is fire-and-forget and opt-in — without the plugin the
pipeline emits nothing and behaves identically. `SignalError` (code
`registry_unavailable`) is raised when the shared registry is absent.

## Diagnostics recorder

`jsails/diagnostics` is an in-memory recorder of typed, value-free
`DiagnosticsEntry` instances. `InMemoryDiagnosticsRecorder({ maxEntries?, clock? })`
builds a bounded ring buffer (default 1000 entries); `diagnosticsPlugin({
recorder?, enabled? })` exposes a `Diagnostics` service under `diagnosticsToken`.
`enabled: false` yields a no-op service.

```ts
import { InMemoryDiagnosticsRecorder } from 'jsails/diagnostics';

const recorder = new InMemoryDiagnosticsRecorder({ maxEntries: 1000 });

recorder.record('request', { route: 'GET /posts', status: 200 });
const entries = recorder.entries();
const stats = recorder.stats();
```

- `wrapAsync(type, fn)` wraps an async call and records its duration — the
  caller sees the error, the recorder observes it.
- `prune(options, now?)` evicts entries older than a cutoff, except the newest
  `keepExceptions` exception entries.
- `pause()` / `resume()` / `isPaused()` gate recording without flushing the
  buffer.

Each `DiagnosticsEntry` carries a monotonic `id` (a decimal string) and, when a
`family` discriminator is present, a `familyHash` (a 12-hex-char SHA-1 hash of
`type` + `data.family`). Neither is ever caller-supplied. No secrets,
credentials, or raw request bodies are recorded.

`createTagRegistry(callbacks)` attaches `"name:value"` tags to entries at record
time; `DiagnosticsRecorderOptions.monitored` names tag keys counted in
`DiagnosticsStats.monitoredCounts`. `DiagnosticsRecorderOptions.filters` gates
entries at record time via `applyFilters` — a throwing filter is fail-closed
(drop).

## Watchers

`createWatcherRegistry()` builds a setup-scoped registry for pluggable
diagnostic watchers. Each `Watcher` owns its own subscription and returns an
unsubscribe from `register`; the registry is sealed after `start()`.

### Request watcher

`RequestWatcher({ signals, slowMs? })` observes the `requestFinished` and
`requestFailed` signals, recording value-free `'request'` / `'failed:request'`
entries with only `method`, `route`, `status`, `durationMs`, and a computed
`slow` flag. Headers, body, URL, and session details never appear.

### Query watcher

`QueryWatcher({ onQuery, slowMs? })` records every database query through
an injected subscriber. Only the parameterized SQL, a `bindingCount`, and a
computed `slow` flag are stored; bindings never appear in any entry. No TypeORM
import or connection is required.

### Exception watcher

`ExceptionWatcherImpl({ capture, signals?, maxFamilies? })` captures unhandled
errors and records value-free `'exception'` entries keyed by a stable `family`
discriminator. Each entry carries `class`, `file`, `line`, `frames` (a frame
count only — the raw stack is never stored), and an optional `context`. A
bounded map keyed by family exposes occurrence counts via `counts()`.

```ts
import { ExceptionWatcherImpl } from 'jsails/diagnostics';

const watcher = new ExceptionWatcherImpl({
  capture: (subscribe) => subscribe((error) => ({ class: error.constructor.name })),
});
const unsubscribe = registry.register(watcher);
```

## Next steps

- [Utility Services](/docs/services) — the cluster of small focused services.
- [Introspection](/docs/introspection) — `inspect`, `describe`, `explain`, and the
  opt-in runtime endpoint.
