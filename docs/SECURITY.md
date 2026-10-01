# Security

This document records JSails' security model and the state of its security review.
It is a snapshot, not a proof of absence of defects — treat the "known gaps" below as
an invitation to audit further.

## Threat model

JSails trusts application code. The framework composes maintained libraries
(TypeORM, Zod, BullMQ, Socket.IO, Preact, Hono, Better Auth) rather than
implementing its own crypto, auth, or queue; it owns the boundaries between them.
The boundaries worth reviewing are the extension/plugin runtime, the install and
enablement gates, the HTTP mutation path, server-component state, uploads, auth,
broadcast, and the deploy tooling.

## Extensions and plugins: trusted, in-process, no sandbox

Extensions (`jsails/extensions`) and plugins run **in the same process as the
application** with full access to its modules, filesystem, environment, and
database. There is **no sandbox**, no permission model, and no process isolation.
`activatePlugins` dynamically imports each enabled plugin's entry module, which
executes that plugin's top-level code at import time. Installing or enabling a
plugin is therefore equivalent to running arbitrary code: a plugin can read
`process.env`, touch the filesystem, or reach the database.

Treat every plugin as trusted. Prefer plugins you have reviewed, and gate the
install surface (see below) to operators you trust.

## Install gates: checksums, optional signature, conflict refusal

Plugin install is not unguarded. `installPlugin`:

- verifies a **SHA-256 checksum** for the downloaded artifact against the
  manifest's `checksums` entry; a mismatch is a hard error
  (`checksum_mismatch`);
- verifies an **optional detached signature** through a caller-supplied
  `verifySignature` verifier; an invalid signature is a hard error
  (`signature_invalid`). When no verifier is configured, a *provided* signature
  is skipped **with a warning**, never treated as verified.

The signature verifier is opt-in: an operator must supply it (a verifier tied to
their own keyring). Without one, checksums still pin integrity but do not attest
authorship.

Plugin enablement also **fails closed on conflict**. An id listed in both the
code enablement list and the managed (database/state) source is *excluded* from
`enabled` and reported as a conflict — the admin refuses to install a
code-managed id, so a conflict is treated as a configuration error, never
silently resolved.

## Enablement: two merged sources

A plugin id is enabled by exactly one of two sources, merged deterministically
(`resolvePluginEnablement`):

- the **code list** (`plugins.enabled` in `jsails.app.js`), the source of truth
  for out-of-the-box/dependency plugins, and
- **managed state** (`jsails_plugin_state` via the database, or
  `<pluginsDir>/state.json`), recording what the admin installed and toggled.

The code list also gates the built-in `config.extensions` by name: an extension
whose name is not listed is skipped before its `setup` runs.

## Admin panel: default-deny, CSRF, origin

Filesystem API routes (and the admin's CRUD resources) are **default-deny**:
`authorize` must resolve to exactly `true`, and a per-resource
`authorize` can only further restrict. Cookie-authenticated mutations
(`POST`/`PUT`/`PATCH`/`DELETE` with a session) require a **same-origin
`Origin`** and a matching **`X-CSRF-Token`**; `publicOrigin` is consulted only
for that check and is never derived from forwarded headers. The first-party
admin panel ships a default-deny `authorize` that allows any signed-in session —
restrict it to an admin role before production use.

## Server components: signed, stateless, and public

Server-component state is carried in a **signed, stateless snapshot**
(HMAC-SHA256 over the state, with expiry and a hashed subject binding), not a
server-side store. An update verifies the snapshot signature, expiry, subject,
and trusted origin **before** the component is looked up, enforces same-origin
plus a CSRF header (session token, or the snapshot id for anonymous components),
re-runs the component `authorize`, applies only the allowlisted `writableKeys`,
validates the strict state schema, and re-signs.

Two properties matter:

- **State is public.** The token is integrity-protected, **not encrypted**.
  Anyone who holds it can read it — never store credentials or secrets in
  component state. The raw session id is never serialized; a purpose-separated
  HMAC tag binds the snapshot to the session.
- **No replay prevention, no exactly-once, no atomic rollback.** A valid token
  is replayed until it expires, and every request reconstructs state from it.
  Persistence done by a handler must be made idempotent by the handler.

## Uploads: signed references, size/type bounds, subject binding

Uploads are not open file writes. An upload is authorized by a **signed
reference** (`createUploadReferenceSigner`) binding the component, a subject
tag, an expiry, the measured size, and the content type. On write, the actual
byte count is measured, the **content type is validated against an allowlist**
(raster images plus PDF by default; SVG is excluded), and the **subject tag is
derived from the verified session**, scoping disk storage to
`<rootDir>/<sha256(subject)>/<id>`. Id and subject segments are validated before
touching a path, so a hostile id/subject cannot traverse the store.

## Authentication: Better Auth over MariaDB

The first-party `auth` plugin backs Better Auth (email/password + RFC 8628
device authorization) over MariaDB. It reads `BETTER_AUTH_SECRET` (≥ 32 bytes)
and, behind TLS termination, `BETTER_AUTH_URL`; credentials are passed through
environment variables, never a committed secret. Cookie-authenticated mutations
fall under the same CSRF + origin discipline as the admin surface. The starter's
flow is login-only; registration, password reset, and email verification are
deferred (see gaps).

## Broadcast: same-port, authenticated, default-deny

Broadcast mounts on the **same HTTP server/port** (`/_jsails/broadcast`), never
a second listener. The built-in Socket.IO adapter enforces a non-empty
**exact-match origin allowlist**, derives identity from **server-side handshake
data** (client-supplied `auth` is never trusted), and **default-denies channel
authorization** when `authorizeChannel` is omitted. A custom `BroadcastAdapter`
is trusted application code that owns all of these checks itself — the core
performs none for it.

## Deploy tooling: hardening is human-run

`jamal harden` and the built-in `harden-server` generator emit a UFW script that
is **reviewed and run by a human**; JSails never executes it, never runs Docker
or `kamal` itself, and deploy generators return config strings only. No secret
is baked into generated configs — credentials are environment references.

## Dependency audit

CI does **not** fail on `npm audit` advisories. The `check` job runs
`npm ci` + `npm run check` (typecheck, lint, format, tests), none of which treat
audit findings as a gate, and `npm ci` does not exit non-zero on vulnerabilities.
Run `npm audit` yourself and triage the findings.

As of this writing, `npm audit --omit=dev` reports **3 high-severity** findings,
all traced to `braces` (a stack-exhaustion denial-of-service via deeply nested
patterns) reached through `nodemon → chokidar → braces`; the only offered fix is
a breaking `nodemon` change, so it is left for a human decision rather than
auto-applied.

## Verification gaps

- **No live external-service coverage in CI.** The unit suite fakes every
  adapter. The `integrations` job runs `verify:integrations` only when the
  `JSAILS_TEST_*` secrets are configured, and skips cleanly otherwise — MariaDB,
  Postgres, Valkey, and Docker paths are not exercised here by default.
- **Windows is untested.** The teardown/install path is exercised only through
  simulated argument/protocol tests; the real end-to-end run is Linux only.
- **Auth lifecycle is incomplete** in the starter (registration, password reset,
  email verification, OAuth are deferred), and there is no finished
  authentication/authorization kit in core — build production auth on
  maintained libraries.
