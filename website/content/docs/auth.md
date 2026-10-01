---
title: Authentication
order: 8
---

# Authentication

The starter always ships a local email/password sign-in flow through the
first-party **`auth` plugin** (`jsails/auth`), which backs **Better Auth over
MariaDB**. It provides email/password sign-in plus RFC 8628 device
authorization, exposes an `AuthSessionService`, and mounts a set of trusted hook
routes. It is deliberately login-only — a starting point you build production
auth on, not a finished authorization system.

## The auth plugin

`authPlugin({ publicOrigin })` lazily builds a Better Auth instance and mounts
its routes. Better Auth is constructed lazily and memoized, so nothing connects
at import or setup time — the database is only touched when a route actually
runs.

The plugin provides an `AuthSessionService` under the `authSessionToken` service
token. The admin panel consumes it by declaring `requires: [authSessionToken]`,
so the `auth` plugin must be declared **earlier** in the extension list than the
`admin` plugin, or assembly fails with a value-free error.

```js
// jsails.app.js  (app-owned, compiled ESM; plain default export)
import { authPlugin } from 'jsails/auth';
import { serverComponentsPlugin } from 'jsails/server-components';
import { taskList } from './dist/components/task-list.js';

export default {
  rootDir: '.',
  plugins: {
    enabled: ['auth', 'cache', 'filesystem', 'mail', 'server-components'],
  },
  extensions: [
    authPlugin({ publicOrigin: process.env.BETTER_AUTH_URL }),
    serverComponentsPlugin({ components: { 'task-list': taskList } }),
  ],
};
```

`resolveSessionFromRequest(createAuth(), request)` and `createAuth` are exported
from the same subpath. The starter's own config sets a global `resolveSession`
this way for the `/api/me` filesystem API and the `/dashboard` page — that
resolves a memoized instance **distinct** from the plugin's own, but both read
the same environment and database.

```js
// jsails.app.js  (app-owned)
import { createAuth, resolveSessionFromRequest } from 'jsails/auth';

const auth = createAuth();

export default {
  resolveSession: (request) => resolveSessionFromRequest(auth, request),
  // ...extensions, including authPlugin
};
```

## Mounted routes

`authPlugin` mounts **trusted hook routes** — native Hono routes added through
the extension seam, never filesystem API routes. That means they bypass the
default-deny `authorize` gate and the cookie-session CSRF middleware, because the
plugin owns its own origin/session checks.

Core sign-in and device flow:

- `/api/auth/*` — the Better Auth handler (email/password, session endpoints).
- `/api/login` and `/api/logout`.
- `/api/device/approve` and `/api/device/deny` — RFC 8628 device authorization.

The account lifecycle handlers are mounted too, alongside the standalone
handlers the barrel exports:

- `/api/register`
- `/api/password-reset` and `/api/password-reset/confirm`
- `/api/verification/send`

The standalone functions `handleRegister`,
`handleRequestPasswordReset` / `handleResetPassword`, and
`handleSendVerificationEmail` let you wire these into your own surfaces.
`buildResetPasswordSender` and `buildVerificationSender` adapt a `SendMailFn` to
the `jsails/mail` transport.

This is **login-only**. Registration UI, password reset, email verification, and
OAuth are deferred in the starter — the routes and handlers are present, but the
starter's pages do not exercise them.

## Roles

Role checks read a session's `role` field. `sessionRole(context)`,
`requireRole(...roles)`, and `adminOnly` each return a strict `RoleCheck`: an
exact `true` allows, anything else denies. They are suitable for a page or API
`authorize` callback, which follows the same exact-`true` default-deny rule as
the rest of the runtime.

```ts
// pages/admin.tsx  (app-owned)
import { adminOnly } from 'jsails/auth';
import type { RequestContext } from 'jsails';

export function authorize(context: RequestContext) {
  return adminOnly(context); // exact true allows, everything else denies
}
```

## API tokens

The same subpath mints long-lived, revocable **API tokens** behind the
`apiTokens` option, **disabled by default**. When `apiTokens.enabled` is set, the
plugin provides an `ApiTokenService` under the `apiTokensToken` service token and
mounts three trusted routes:

- `POST /api/tokens`
- `GET /api/tokens`
- `DELETE /api/tokens/:id`

Token management requires a signed-in **browser** session plus same-origin and
CSRF checks.

A token is a Better Auth session tagged with a `jsails/api-token:` `userAgent`
sentinel, so it rides the existing session table with no new schema.
`createApiToken` returns the raw secret **exactly once** — it is never listed or
stored again.

`AuthSessionService.resolveSession` resolves the cookie session first, then falls
back to the `Bearer <token>` credential in the configured header — and only when
tokens are enabled. The header defaults to `authorization`, overridable via
`apiTokens.headerName`. `apiTokens.expiresInDays` defaults to `30` (bounded
`1..3650`).

```js
// jsails.app.js  (app-owned)
import { authPlugin } from 'jsails/auth';

export default {
  extensions: [
    authPlugin({
      publicOrigin: process.env.BETTER_AUTH_URL,
      apiTokens: { enabled: true, expiresInDays: 90 },
    }),
  ],
};
```

```sh
curl -H "Authorization: Bearer $TOKEN" https://app.example.com/api/me
```

## Environment and setup

Auth requires a database connection. The recommended default is MariaDB, started
locally with `jamal up` (which also starts Valkey). JSails reads the connection
from individual variables — there is **no `DATABASE_URL`**:

- `DATABASE_HOST`
- `DATABASE_PORT` (default `3306`)
- `DATABASE_USER`
- `DATABASE_PASSWORD`
- `DATABASE_NAME`

Better Auth reads:

- `BETTER_AUTH_SECRET` — export it before serving, at least 32 bytes.
- `BETTER_AUTH_URL` — the public origin, used behind a TLS-terminating proxy
  (default `http://localhost:3000`); in the starter it is also passed as
  `publicOrigin`.

Create Better Auth's tables and the first account with the starter's scripts:

```sh
npm run auth:migrate                        # create Better Auth's tables
npm run user:create -- <email> <password> [name]   # create the first account
```

## Next steps

- [Plugins & Extending](/docs/plugins-and-extending) — the extension seam,
  service tokens, and how the `auth` plugin consumes them.
