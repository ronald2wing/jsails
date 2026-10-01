---
title: Configuration
order: 5
---

# Configuration

JSails reads configuration from two places: **environment variables** (validated
by typed readers) and a single compiled ESM module, `jsails.app.js`, whose
default export is a plain object. Nothing opens a connection until `serve()` or
an extension's own `setup` does.

## Environment configuration

`readEnvironment(schema, source?)` validates a plain
`Record<string, string | undefined>` (defaulting to `process.env`) against a Zod
schema and returns typed config. It **never loads a `.env` file, never mutates
the source or `process.env`**, and resolves the default source when a reader is
called — not at import.

Failures are `EnvironmentError`s whose issues carry `{ path, code, message }`
only: custom Zod messages, thrown transform/refine errors, `.cause`, and raw
values (including credentials) are never surfaced.

`readDatabaseEnvironment(source?)` and `readValkeyEnvironment(source?)` are
opt-in service readers. A static site that never calls them needs neither a
database nor Valkey; call them explicitly where the service is used.

```js
// jsails.config.js  (app-owned; plain ESM)
import { JsailsDataSource, readDatabaseEnvironment } from 'jsails';
import { User } from './entities/user.js';

const database = readDatabaseEnvironment();

export default new JsailsDataSource({ ...database, entities: [User] });
```

- Database defaults to `mariadb` (port `3306`); `postgres` defaults to `5432`,
  and the legacy `mysql` driver is retained. `DATABASE_HOST`, `DATABASE_USER`,
  `DATABASE_PASSWORD`, and `DATABASE_NAME` are required — there is no implicit
  database.
- Valkey resolves `VALKEY_URL`.
- Readers accept an injected source and never fall back to `process.env` once
  one is given.

## Application config — `jsails.app.js`

An app ships one compiled ESM module (default `jsails.app.js`) whose default
export is a plain object. `loadAppConfig(path?)` imports it and
`validateAppConfig` resolves absolute directories; `createApplication(config)`
discovers routes, runs the extensions, then the app's `setup` hook, and returns
an inert `Application` (`build()`, `serve()`, `close()`).

```js
// jsails.app.js  (app-owned; plain ESM, compiled JS)
export default {
  rootDir: '.',      // defaults to the config file's directory
  pages: 'pages',    // relative to rootDir
  api: 'api',        // relative to rootDir
  public: 'public',  // relative to rootDir
  out: 'out',        // relative to rootDir
  storage: 'storage', // relative to rootDir; resolved to storageDir
  healthPath: '/up',  // GET/HEAD 200; false disables the health route
  host: '127.0.0.1',
  port: 3000,        // 0 requests an ephemeral port
};
```

`host`, `port`, and `out` come from the config, not CLI flags.

### Directories and storage

`storage` defaults to `storage` and resolves to `ResolvedAppConfig.storageDir`
(the folder need not exist yet). `serve` creates it before listening; `build`
and `fetch` never materialize it. The resolved directory reaches pages/API as
`RequestContext.storagePath` (absent when the static export synthesized the
context without one).

Isolation guards reject a `storageDir` that equals the project root, overlaps
`public`/`out` in either direction, or contains the config module. `public` must
not contain the project root, overlap `pages`/`api`/`out` in either direction,
or contain the config file. The static build refuses to overwrite a non-empty
`out` without its own ownership marker.

### Health route

`healthPath` is a `string` or `false` and defaults to `/up`. The resolved config
exposes it as `healthPath: string | undefined` (`false` becomes `undefined`).
The framework route answers `GET`/`HEAD` with `200 text/plain; charset=utf-8`
and `Cache-Control: no-store`, **independent of the default-deny API pipeline**.
A path must be absolute, have no trailing slash (except `/`), and stay outside
the reserved `/_jsails` namespace; a collision with a discovered page/API route
is rejected when the application is assembled.

### Renderer, extensions, and broadcast

- `renderer` is a `PageRenderer` passed through directly; only its `render`
  function is checked, never called.
- `extensions` is the list of extensions the app declares. `setup()` runs last
  and may return a cleanup callback; neither is invoked by the loader. If
  `setup` throws, already-opened extensions are closed first.
- `broadcast` accepts either the built-in Socket.IO options (with a `valkeyUrl`
  key, mapped to the transport's `redisUrl`) or `{ adapter }`. The custom form is
  validated structurally (non-empty `name` + `attach`) and passed through by
  identity; its `attach` is never invoked by the loader.

### Introspection

`introspect: { enabled, authorize, sections? }` opts into the runtime
`GET /_jsails/introspect` endpoint. It is default-off and default-deny:
`authorize` is **required** when `enabled` is `true` (the loader raises a
load-time `AppConfigError` otherwise) and follows the same exact-`true`
default-deny rule as the rest of the runtime.

## Sessions, authorization, and CSRF

- `authorize(context)` is **default-deny**: absent means every API request is
  rejected, and a request is allowed only when the callback resolves to exactly
  `true` (truthy non-boolean, throw, or rejection all deny). There is no
  implicit-public default.
- `resolveSession(request)` is the trusted session seam; when absent the context
  carries `session: null`, and a throwing/rejecting resolver fails closed.
- Cookie-authenticated mutations (`POST`/`PUT`/`PATCH`/`DELETE` with a session)
  require a same-origin `Origin` and a matching `X-CSRF-Token`. Behind a
  TLS-terminating proxy the request URL is plain HTTP, so set `publicOrigin` to
  the public https origin — forwarded headers are never trusted. `publicOrigin`
  is consulted only for that `Origin` check (and the equivalent check on signed
  server-component updates); plain page rendering, static export, and the health
  route never need it.

## Shutdown

`close()` is idempotent and tears down in reverse (HTTP/broadcast → app cleanup
→ extensions). `shutdownTimeoutMs` (default `5000`, max `300000`) bounds
transport teardown: idle/all connections are force-closed and a server that will
not stop has its tracked sockets destroyed at the deadline. The app cleanup and
extension cleanups are trusted and awaited **without** a deadline — each owns its
own async cleanup; this is bounded teardown, not a full graceful drain of active
connections.

```sh
jsails build --config jsails.app.js   # static export into `out`
jsails serve --config jsails.app.js   # listen until SIGINT/SIGTERM
```

## Next steps

- [Pages & Routing](/docs/pages-and-routing) — your first page and API route.
