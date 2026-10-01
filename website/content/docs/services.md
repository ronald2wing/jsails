---
title: Services & Utilities
order: 11
---

# Services & Utilities

JSails ships a cluster of small, focused services you can opt into: caching and
rate limiting, feature flags, mail, filesystem blobs, notifications, database
sessions, validation rules, an HTTP client, and a dependency-free translator.
Each is a narrow contract with an in-memory default and, where it makes sense, a
first-party plugin that exposes it under a typed service token. Construction is
inert — nothing connects until you call a method.

## Cache

`jsails/cache` is a narrow string-keyed `CacheStore` contract with an in-memory
default (`createMemoryCacheStore`) and an optional Valkey/Redis backend
(`createValkeyCacheStore`). A fixed-window `createRateLimiter` runs over the same
store — `guard` for the check and `rateLimitResponse` for a value-free `429`.
`cachePlugin` exposes a `CacheStore` under `cacheToken`. The API-facing `throttle`
helper builds on this same limiter.

```js
import { createMemoryCacheStore, createRateLimiter } from 'jsails/cache';

const store = createMemoryCacheStore();
const limiter = createRateLimiter({ store, limit: 60, windowMs: 60_000 });
```

## Feature flags

`jsails/flags` is a boolean gate the app flips without a deploy. A flag is a
non-empty `key` plus an optional `scope`; the global scope and each scoped
namespace are independent, so the same key can be active in one scope and
inactive elsewhere. `createMemoryFeatureStore` is the zero-config default, and
`createDatabaseFeatureStore({ dataSource })` backs the `jsails_feature_flag`
table. `resolveFeature(flags, key, scope?)` returns `{ active, inactive }` to
compose with `??`, and `flagsPlugin({ store? })` exposes a `FeatureFlags` service
under `flagsToken`.

```js
import { createMemoryFeatureStore, resolveFeature } from 'jsails/flags';

const flags = createMemoryFeatureStore();
const { active, inactive } = resolveFeature(flags, 'new-dashboard', 'user:42');
const view = active ?? inactive;
```

## Mail

`jsails/mail` is a minimal, transport-agnostic mail seam: the `Mailer` contract
plus three transports and a first-party plugin. Use `createMemoryTransport`
(in-memory capture for tests), `createCallbackTransport` (an injected callback),
or `createSmtpTransport` (lazy SMTP over nodemailer, loaded at first send).
`mailPlugin({ transport, transportOptions })` exposes the mailer under
`mailToken` with lazy, fail-closed transport resolution. The subpath is
server-only; nodemailer is pulled in only when SMTP is actually used.

```js
import { createMemoryTransport, mailPlugin } from 'jsails/mail';

const mail = mailPlugin({ transport: createMemoryTransport() });
```

## Filesystem

`jsails/filesystem` is a keyed blob-store `Disk` contract with two
implementations and a plugin. `createLocalDisk(options)` backs a disk with the
local filesystem; `createMemoryDisk(options)` is an in-memory disk for tests and
demos; `filesystemPlugin({ disks })` exposes a named `FileSystem` service over
those disks under `filesystemToken`. On top of it, `defineVariant` /
`createVariantResolver` lazily cache transformations of a stored source file
(the caller supplies the transform — no image library dependency), and
`createRichText` is a sanitized HTML value object with plain-text extraction.

```js
import { createLocalDisk, filesystemPlugin } from 'jsails/filesystem';

const filesystem = filesystemPlugin({
  disks: { uploads: createLocalDisk({ root: 'storage/uploads' }) },
});
```

## Notifications

`jsails/notifications` is a narrow, multi-channel delivery seam. A
`NotificationMessage` is smaller than a mail message — `to`, `subject`, and a
required plain-text `text` body — so any channel (mail, SMS, push) can consume
it. Two channels ship: `createMemoryChannel` captures messages in-process, and
`createMailChannel({ mailer })` adapts the `jsails/mail` `Mailer`.
`notificationsPlugin({ channels?, mail? })` exposes a `NotificationsService`
under `notificationsToken`; `notify(message, { channels? })` sends through every
selected channel and aggregates failures into a value-free `NotificationError`.
There is no durable queue, retry policy, or database — enqueue with the jobs
plugin if you need retries.

```js
import { createMemoryChannel, notificationsPlugin } from 'jsails/notifications';

const notifications = notificationsPlugin({
  channels: { memory: createMemoryChannel() },
});
```

## Sessions

`jsails/sessions` carries the framework-owned session entity and a
database-backed `SessionStore`. `JsailsSession` maps the `jsails_session` table
(`SESSION_TABLE`, `SESSION_ID_COLUMN_LENGTH`); add `sessionEntities` to a
`JsailsDataSource` `entities` and run the normal `makemigrations`/`migrate`
history. `createDatabaseSessionStore({ dataSource })` builds the store through
the data source's repository — no raw SQL, no runtime DDL; a missing table fails
with a value-free `SessionStoreError`.

```js
import { createDatabaseSessionStore, sessionEntities } from 'jsails/sessions';

const sessions = createDatabaseSessionStore({ dataSource });
```

## Validation

`jsails/validation` provides composable, value-free Zod-backed validation rules
and a bulk validation helper. Each rule returns a Zod schema (for direct
composition into `z.object({...})`) or a `ValidationRule` predicate for
cross-field checks — `required`, `email`, `url`, `minLength` / `maxLength`,
`min` / `max`, `regex`, and `inList` are schema rules, while `confirmed(field)`
and `when(condition, rule)` are predicates. `validateFields(schema, values)`
runs a Zod object schema and returns a flat array of value-free `FieldError`
objects. Messages never echo input values.

```js
import { confirmed, validateFields, when } from 'jsails/validation';

const errors = validateFields(schema, values);
// confirmed('password') requires password_confirmation to match
```

## HTTP client

`jsails/http` is a thin fetch-based HTTP client seam with typed
`get`/`post`/`put`/`patch`/`delete` methods. Every method encodes/decodes JSON,
enforces a bounded timeout via AbortController, and surfaces failures as
value-free `HttpClientError`s (status + message; never the request URL or
response body). Pass an injectable `fetch` for testing — the client uses
`globalThis.fetch` by default.

```js
import { createHttpClient } from 'jsails/http';

const http = createHttpClient({ baseUrl: 'https://api.example.com' });
const user = await http.get('/users/42');
```

## Internationalization

`jsails/i18n` is a dependency-free message translator over nested string maps
the caller loads from plain JSON/objects — this slice performs no file-system or
environment resolution. `createTranslator({ messages, locale?, fallbackLocale? })`
returns a `Translator` with `t(key, params?)` for dot-path keys and `{name}`
interpolation, and `tChoice(key, count, params?)` for plural selection driven by
the built-in `Intl.PluralRules`. `locale()` / `fallbackLocale()` / `withLocale(next)`
read or derive the active locale. The translator holds the passed `messages`
reference and never mutates it.

```js
import { createTranslator } from 'jsails/i18n';

const t = createTranslator({ messages, locale: 'en', fallbackLocale: 'en' });
t('nav.home');
tChoice('cart.items', 3);
```

## Signals

`jsails/signals` is a service-layer **signal bus** over the shared
interceptor/observer registry. `createSignalBus(registry)` wraps an
`InterceptorRegistry` as a `SignalBus` (`observe`/`emit`), and `signalsPlugin()`
exposes that bus under the typed `signalsToken` service. The bus adds no
buffering, durability, or removal API — it delegates to the registry, whose seal
guard applies (registration closes after setup; `emit` stays callable). `emit`
isolates observer errors: it never throws and resolves to a `readonly unknown[]`
of the errors thrown by observers.

Because the bus is the **shared** registry, an observer registered by one plugin
fires for events emitted by another. `SetupContext`/`PluginContext` expose
`interceptorRegistry` directly, so a plugin can run its own operations through
the shared graph (`runBefore`/`runAfter`/`emit`) instead of a private registry.

```js
import { defineEvent, definePlugin } from 'jsails/extensions';
import { signalsPlugin, signalsToken } from 'jsails/signals';

const postCreated = defineEvent('post.created');

const observer = definePlugin({
  name: 'audit',
  setup({ observe }) {
    observe(postCreated, (payload) => console.log('created', payload));
  },
});

// A handler reaches the bus through the request context.
const emitFromHandler = (context) => {
  const bus = context.services.get(signalsToken);
  return bus.emit(postCreated, { id: 1 });
};
```

`requestStarted` / `requestFinished` / `requestFailed` are built-in lifecycle
events emitted by the API pipeline when the signals plugin is enabled. Their
`RequestSignalPayload` is value-free: it carries the `Request`, `URL`, params,
method, route, and `session` (server-only), but never the body, headers, or
cookies. Emission is fire-and-forget and opt-in — without the plugin the pipeline
emits nothing and behaves identically.

## Logging

`jsails/logging` is a **record-first** structured logging service. The record is
the API and the string is a rendering: `logger.info(msg, context?)` builds a
frozen `LogRecord { level, message, context, at }`, and each channel receives the
record. `createLogger(options?)` is the standalone factory; `loggerPlugin()`
provides a `Logger` under the typed `loggerToken` service. Construction is inert —
no I/O until a log method is called.

```js
import { createLogger, consoleChannel, jsonFormatter, memoryChannel } from 'jsails/logging';

const logger = createLogger({
  channels: [consoleChannel({ formatter: jsonFormatter() }), memoryChannel()],
});

logger.info('server started', { port: 3000 });
const requestLog = logger.child({ requestId: 'abc' });
requestLog.warn('slow query', { ms: 812 }); // requestId is merged into every record
```

- **Levels** — `debug` | `info` | `warn` | `error`, ordered; each channel has its
  own `minLevel` threshold.
- **Channels** are the pluggable seam (`{ name, minLevel, write(record) }`):
  `consoleChannel()` (default), `memoryChannel()` (tests; raw `records()`), and
  `nullChannel()`.
- **Formatters** are pluggable: `jsonFormatter()` (stable key order) and
  `lineFormatter()`. Both never throw — a circular or `toJSON`-throwing value
  becomes `"[unserializable]"`.
- **`child(context)`** merges bound context into every record (child overrides
  parent).
- **Composition** — an optional `diagnostics` recorder gets a value-free
  `{ type: 'log', data: { level, message } }` entry, and an optional `signals` bus
  emits the shared `logError` event for `error`-level records. Both sinks are
  failure-isolated.

**Value-free by default:** there is no automatic secret redaction — `context` is
caller-owned, so never place credentials in it. The built-in formatters serialize
only the four record fields and never stack traces or `cause` chains.

**v1 limits:** no `file`/`daily`/`stack` channels (the channel contract makes them
additive); no async channel flush; no runtime level mutation; no global logger
singleton.

## Encryption

`jsails/encryption` is a symmetric **AES-256-GCM** encrypter built on
`node:crypto` (no new dependency). `createEncrypter({ key, previousKeys? })`
returns an inert `Encrypter` with `encrypt(plaintext, { aad? })` and
`decrypt(token, { aad? })`; `encryptionPlugin(options)` provides it under the
typed `encryptionToken` service.

```js
import { createEncrypter } from 'jsails/encryption';

const encrypter = createEncrypter({ key: process.env.APP_ENCRYPTION_KEY });

const token = encrypter.encrypt('card number', { aad: 'user:42' });
encrypter.decrypt(token, { aad: 'user:42' }); // 'card number'
encrypter.decrypt(token, { aad: 'user:43' }); // throws decryption_failed
```

- **Envelope** — `v1.<iv>.<tag>.<ciphertext>`, each part base64url. The `v1`
  version tag is mandatory so a future format is rejected with
  `unsupported_version` rather than misparsed. The IV is 12 random bytes per
  call; the tag is 16 bytes.
- **Key model** — a `string` key is a high-entropy secret of at least 32 bytes
  from which a 32-byte AES key is derived with HKDF-SHA256; a `Uint8Array` key is
  used verbatim and must be exactly 32 bytes. Truncation is deliberately avoided
  so two secrets sharing a 32-byte prefix cannot collide.
- **Key rotation** — `previousKeys` is decrypt-only: `encrypt` always uses `key`,
  while `decrypt` tries `key` first, then each `previousKeys` entry in order.
- **AAD** — an optional `aad` string is bound into the GCM tag; a mismatch fails
  authentication with `decryption_failed`.
- **No global secret** — the key is always passed explicitly; there is no
  `JSAILS_ENCRYPTION_KEY` environment fallback.
- **Value-free errors** — `EncryptionError` never echoes the key, plaintext,
  ciphertext, token, or AAD.

**v1 limits:** no passphrase KDF (a string key is a secret, not a password); no
`encrypts`-style entity attribute hook yet — GCM is non-deterministic, so an
encrypted column cannot be queried by equality (deferred to T1.6b). The module is
server-only and must never enter the browser-safe `jsails/api`/`jsails/client`
graphs.

## Job middleware, chaining, and batching

`jsails/jobs` provides three built-in composition patterns — middleware,
chaining, and batching — that run on top of the neutral job runtime. All three
are **worker-side only**: they compose around the handler after payload
validation, and dispatch options carry the control descriptors.

### Per-job middleware

`composeMiddleware` wraps the handler with `JobMiddleware` functions registered
per job name via `createJobsRuntime({ middleware: { [jobName]: [mw, ...] } })`.
Middleware runs in declared order outermost-first on the worker; `next()` is
callable at most once, and returning without `next()` short-circuits the chain.
Errors propagate as `JobMiddlewareError` (codes `invalid_middleware` /
`middleware_threw`).

```js
import { createJobsRuntime, composeMiddleware } from 'jsails/jobs';

const loggingMiddleware = async (ctx, next) => {
  console.log(`starting ${ctx.name} (${ctx.jobId})`);
  await next();
  console.log(`finished ${ctx.name}`);
};

const runtime = createJobsRuntime({
  registry,
  adapter,
  middleware: { sendEmail: [loggingMiddleware] },
});
```

### Chaining

`createJobChain(runtime, steps)` builds a sequential pipeline: the
`chainMiddleware`, registered on every chained job, enqueues step N+1 only after
step N's handler succeeds. The chain descriptor rides in dispatch options under
the reserved `CHAIN_OPTION_KEY`. Chaining is at-least-once: a retried step
re-runs the handler and continues on success — handlers must be idempotent.
`JobChainError` (codes `empty_chain` / `invalid_step`) rejects a malformed chain.

```js
import { createJobChain, chainMiddleware, CHAIN_OPTION_KEY } from 'jsails/jobs';

const runtime = createJobsRuntime({
  registry,
  adapter,
  middleware: { stepA: [chainMiddleware], stepB: [chainMiddleware], stepC: [chainMiddleware] },
});

const chain = createJobChain(runtime, [
  { job: 'stepA', data: { file: 'report.csv' } },
  { job: 'stepB', data: {} },
  { job: 'stepC', data: {} },
]);
await chain.dispatch();
```

### Batching

`createJobBatch(runtime, coordinator, items, callbacks?)` fans out N jobs, each
carrying a `BatchDescriptor` under the reserved `BATCH_OPTION_KEY`. The per-job
`createBatchMiddleware(coordinator)` records every item's outcome into an
**injectable** `BatchCoordinator`; when all items settle, `then` (all ok) /
`catch` (any failed) / `finally` (always) fire once, in that order. Recording
is idempotent per item index; settlement is single-fire; callback errors are
swallowed. `JobBatchError` (codes `empty_batch` / `invalid_item`) rejects a
malformed batch.

```js
import {
  createJobBatch,
  createBatchCoordinator,
  createBatchMiddleware,
} from 'jsails/jobs';

const coordinator = createBatchCoordinator();

const runtime = createJobsRuntime({
  registry,
  adapter,
  middleware: { processItem: [createBatchMiddleware(coordinator)] },
});

const batch = await createJobBatch(runtime, coordinator, [
  { job: 'processItem', data: { id: 1 } },
  { job: 'processItem', data: { id: 2 } },
], {
  then: (summary) => console.log('all done', summary),
  catch: (failed) => console.error('some failed', failed),
});
```

**Limitation:** the built-in coordinator is in-process. A deployment with
separate producer and worker processes must supply a coordinator backed by
shared storage, or callbacks will not fire.

## Task scheduling and overlap control

`jsails/jobs` provides a `ScheduleDefinition.overlap` option to prevent
concurrent runs of the same scheduled job. The overlap descriptor rides in the
scheduled job's dispatch options under the reserved `OVERLAP_OPTION_KEY`, and a
per-job middleware — `createOverlapMiddleware(mutex)` — gates execution behind
a mutex store.

The mutex store itself lives in `jsails/cache`. It is a separate contract from
`CacheStore`: a cache is pure data whose `set` always overwrites, while a mutex
needs an atomic "acquire only when absent" operation. Two stores ship:
`createMemoryMutexStore()` (single-process; in-memory `Map` with expiry) and
`createValkeyMutexStore({ valkeyUrl? })` (multi-process via atomic `SET NX PX`).

```js
import { createJobsRuntime, createOverlapMiddleware } from 'jsails/jobs';
import { createMemoryMutexStore } from 'jsails/cache';

const mutex = createMemoryMutexStore();

const runtime = createJobsRuntime({
  registry,
  adapter,
  middleware: {
    digest: [createOverlapMiddleware(mutex)],
  },
  schedules: [
    { id: 'digest', job: 'sendDigest', cron: '0 3 * * *', overlap: true },
  ],
});

// Read-only schedule list — names and metadata only, never payloads or data.
const schedules = await runtime.listSchedules();

// Pause the named schedules (removes their repeatable jobs from the provider).
await runtime.pauseSchedules(['digest']);
```

**Limits:**
- **Pause is non-durable** — `pauseSchedules` removes the repeatable job; the
  next `work` start re-registers every schedule from config via
  `upsertSchedules`, so a paused schedule resumes automatically on process
  restart. There is no separate `resumeSchedules` call — resume by re-calling
  `upsertSchedules`.
- **The memory mutex is single-process only** — competing worker processes each
  have their own in-memory map, so they cannot see each other's locks. Use
  `createValkeyMutexStore` for multi-process deployments.

## Next steps

- [Testing](/docs/testing) — the in-process `createTestApp` surface and the
  native `node:test` suite.
