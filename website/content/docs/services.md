---
title: Utility Services
order: 23
section: Reference
---

# Utility Services

JSails ships a cluster of small, focused utility services you can opt into:
caching and rate limiting, mail, filesystem blobs, notifications, validation
rules, and an HTTP client. Each is a narrow contract with an in-memory default
and, where it makes sense, a first-party plugin that exposes it under a typed
service token. Construction is inert — nothing connects until you call a method.

## Cache

`jsails/cache` is a narrow string-keyed `CacheStore` contract with an in-memory
default (`MemoryCacheStore`) and an optional Valkey/Redis backend
(`ValkeyCacheStore`). A fixed-window `FixedWindowRateLimiter` runs over the same
store — `guardRateLimit` for the check and `rateLimitResponse` for a value-free
`429`.
`cachePlugin` exposes a `CacheStore` under `cacheToken`. The API-facing `throttle`
helper builds on this same limiter.

```js
// No import: these are projected globals in app code (see conventions.md).

const store = new MemoryCacheStore();
const limiter = new FixedWindowRateLimiter({ store, limit: 60, windowMs: 60_000 });
```

## Mail

`jsails/mail` is a minimal, transport-agnostic mail seam: the `Mailer` contract
plus three transports and a first-party plugin. Use `InMemoryMailTransport`
(in-memory capture for tests), `CallbackMailTransport` (an injected callback),
or `SmtpMailTransport` (lazy SMTP over nodemailer, loaded at first send).
`mailPlugin({ transport, transportOptions })` exposes the mailer under
`mailToken` with lazy, fail-closed transport resolution. The subpath is
server-only; nodemailer is pulled in only when SMTP is actually used.

```js
// No import: these are projected globals in app code (see conventions.md).

const mail = mailPlugin({ transport: new InMemoryMailTransport() });
```

## Filesystem

`jsails/filesystem` is a keyed blob-store `Disk` contract with two
implementations and a plugin. `new LocalDisk(options)` backs a disk with the
local filesystem; `new MemoryDisk(options)` is an in-memory disk for tests and
demos; `filesystemPlugin({ disks })` exposes a named `FileSystem` service over
those disks under `filesystemToken`. On top of it, `defineVariant` /
`DiskVariantResolver` lazily cache transformations of a stored source file
(the caller supplies the transform — no image library dependency), and
`SanitizingRichTextFactory` is a sanitized HTML value object with plain-text extraction.

```js
// No import: these are projected globals in app code (see conventions.md).

const filesystem = filesystemPlugin({
  disks: { uploads: new LocalDisk({ root: 'storage/uploads' }) },
});
```

## Notifications

`jsails/notifications` is a narrow, multi-channel delivery seam. A
`NotificationMessage` is smaller than a mail message — `to`, `subject`, and a
required plain-text `text` body — so any channel (mail, SMS, push) can consume
it. Two channels ship: `InMemoryNotificationChannel` captures messages in-process, and
`MailNotificationChannel({ mailer })` adapts the `jsails/mail` `Mailer`.
`notificationsPlugin({ channels?, mail? })` exposes a `NotificationsService`
under `notificationsToken`; `notify(message, { channels? })` sends through every
selected channel and aggregates failures into a value-free `NotificationError`.
There is no durable queue, retry policy, or database — enqueue with the jobs
plugin if you need retries.

```js
// No import: these are projected globals in app code (see conventions.md).

const notifications = notificationsPlugin({
  channels: { memory: new InMemoryNotificationChannel() },
});
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
// No import: these are projected globals in app code (see conventions.md).

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
// No import: these are projected globals in app code (see conventions.md).

const http = new FetchHttpClient({ baseUrl: 'https://api.example.com' });
const user = await http.get('/users/42');
```

## Facades

A facade resolves a service by a stable name through the **ambient application
scope**, so a call site writes `Cache.get('x')` with no `new`, no import, and no
token. Any author — framework or application — can make their own class a facade
in one line.

```ts
import { facade, installFacades } from 'jsails/facades';

// One line makes YOUR class a facade. `cacheToken` carries the type.
export const Cache = facade(cacheToken);

// At boot, opt in to the names you want available globally.
installFacades({ Cache, Logger, Encrypter });
```

Inside any request, setup hook, or the app `setup`, the facade resolves to the
current application's service:

```ts
Cache.get('session:42'); // forwarded to the instance, typed
Logger.child({ req }).info('handled'); // real logger; chains natively
```

Resolution is by **token identity**, never a string key, and happens **per call**
against the current scope — so the same facade name resolves correctly under any
number of concurrently-live applications (a test app and a served app never
collide), and a call after the app closes fails cleanly instead of returning a
stale instance. `facade(token)` memoizes **per token**: repeated calls with the
same token return the same proxy, so an `installFacades` re-run across two live
apps is a no-op rather than a collision.

- `facade(token)` — a typed proxy over the token's service `T`, canonical per
  token. Use it directly (no global) for CLI scripts, pre-app code, and tests.
- `installFacades({ ... })` — publish names onto `globalThis`. Idempotent when
  the same token's proxy is reinstalled; a name held by a *different* facade
  raises a `TypeError`.

**Errors** are value-free `FacadeError`s: `no_app_scope` when used outside app
work (a top-level CLI script, or after `close()`), and `unresolved` when the
scope has no provider for the token.

**Honest limits.** Facades are server-only (`jsails/facades` reaches
`node:async_hooks` for the ambient scope) and meaningless outside application
work — resolve through a token or the extension runtime there. Detaching a
method (`const { get } = Cache`) loses binding; call through the proxy. Which
services become global names is opt-in. The `work`-driven job runtime resolves
facades inside job handlers and middleware when the runtime config declares
`extensions`; absent `extensions`, behavior is unchanged (`no_app_scope`).

```js
// jsails.runtime.js  (declaring extensions so facades resolve in job handlers)
export default {
  registry: createJobRegistry({ sendEmail }),
  valkeyUrl: 'redis://127.0.0.1:6379',
  extensions: [cachePlugin()],
};
```



- [Presentation & Toggles](/docs/presentation) — theme tokens, feature flags, and internationalization.
- [Observability](/docs/observability) — logging, signals, diagnostics, and watchers.
- [Encryption](/docs/encryption) — symmetric AES-256-GCM encryption.
- [Support Helpers](/docs/support) — the global `Str`/`Num`/`Time`/`Arr`/`Files` toolkit.
