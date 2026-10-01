---
title: Deployment
order: 13
---

# Deployment

JSails ships **Jamal** (`jsails jamal`) — a TypeScript reimplementation of
Kamal + Sail behind one config file — plus pure deploy-config generators and an
opt-in Basecamp ONCE preset. Deployment verbs execute by default; pure planners
and config generators never run Docker, resolve secrets, or open a connection.

## Jamal

`jsails jamal` is the deployment/planning CLI. Subcommands are `up | down | ps |
logs | exec | status | dev | deploy | rollback | harden | targets | domain |
accessory | app | registry | prune | audit | snapshot`.

### `jamal.config.js`

`jamal.config.js` is a plain ESM module whose default export is a `JamalConfig`.
There is no `mode` flag: the base fields plus non-destructive `local` (ports/
build) and `production` (server/domain/onDemandTlsUrl/registry) overlay sections
drive both environments. Secrets are `SecretRef`s — a name only, never resolved
or serialized — and `redactJamalConfig` renders a plan-safe view.

### Local execution verbs

Execution verbs (`up`/`down`/`ps`/`logs`/`exec`) drive `docker compose` against
the local project. `up` materializes the managed `.jamal/compose.yml` from
`jamal.config.js` and runs `docker compose up -d --wait`; `down`/`ps`/`logs` use
that managed file/project when it exists, else fall back to the legacy
`docker-compose.yml` from `jamal dev --write`. `exec <service> -- <cmd...>`
requires the managed file. `--detach` is accepted for `up` and is already the
default; `--follow` tails `logs`. `jamal dev` plans the local Docker Compose set
(Valkey + database) and writes nothing until `--write`.

```sh
jsails jamal up
jsails jamal ps
jsails jamal logs --follow
jsails jamal exec web -- node dist/src/cli.js migrate
```

### Deploy executes by default

`jamal deploy` runs a **production release** — production is the default and
`jamal dev` is the explicit local override. `--dry-run` prints the plan and runs
nothing. `--target kamal` is the default engine: it builds and pushes the image
locally, then pulls, runs, health-checks, switches, and stops the previous
container on the remote server.

```sh
jsails jamal deploy
jsails jamal deploy --tag v1.4.0
jsails jamal deploy --dry-run
jsails jamal rollback
```

`rollback` redeploys the previous successful tag and also executes by default,
with `--dry-run` as its preview. Both record the deployed tag in
`.jamal/deploys.json`. `status` lists remote containers, and `logs`/`exec`
inspect the last deployed container. These verbs require `config.production` and
drive the release engine in `src/jamal/production/execute.ts`
(`runDeployExecution`/`runRollbackExecution`). `--execute` is kept as a
deprecated no-op alias — `deploy`/`rollback` already execute.

Production execution first provisions the declared backing services
(MariaDB/Postgres/Valkey accessory containers published on loopback). `jamal app
<verb>` drives the app container over ssh against the LATEST recorded deploy
(`containers` filters by service name), and `jamal accessory <verb>` manages the
backing-service containers; both require `config.production` and support
`--dry-run`.

### Static and custom targets

A static or custom target (`--target vercel|netlify|cloudflare|github`, plus any
custom deployment generator from `deployments` in `jsails.app.js`) only
**generates files**, requires `--write`, and is never deployed by Jamal. Deploy
the output with the host's own CLI:

```sh
jsails jamal deploy --target vercel --write
npx vercel deploy --prod
```

`targets` lists every available target. `--write` materializes generated files
with exclusive creation (an existing file is skipped, never overwritten), and
`--dir <path>` relocates the plan.

### Pure planners

Several subcommands produce a plan and never execute; they return plan objects,
never run Docker, resolve secrets, or open a connection:

- `jamal registry` — builds the `docker login` argv from the production registry
  config (password redacted).
- `jamal prune --keep <n> [--images <ref>...]` — plans image removal keeping the
  N most recent per service group.
- `jamal audit` — produces a security checklist from the Jamal config.
- `jamal snapshot <service> [--name <name>] [--driver mariadb|postgres]` and
  `jamal snapshot restore <service> --snapshot <path> [--driver ...]` — build
  `docker compose exec` argv arrays for MariaDB and Postgres dump/restore.

### On-demand TLS

`production.onDemandTlsUrl` opts a deploy into kamal-proxy's on-demand TLS. It is
mutually exclusive with `production.domain`: when set, the proxy routes unknown
hostnames and authorizes each at certificate-issuance time instead of pinning one
static host — the `switch` step carries `kamal-proxy deploy ... --tls-on-demand-url
<url>` and no `--host`. The value must be an absolute `http://` or `https://`
URL, or a local path starting with `/`; any other scheme, or a value with
whitespace/control characters, is rejected when the config is normalized.

```js
// jamal.config.js  (app-owned; plain ESM)
export default {
  production: {
    onDemandTlsUrl: 'http://127.0.0.1:3001/allowed',
  },
};
```

The proxy authorizes each hostname by calling `GET <url>?host=<hostname>` with a
matching `Host` header: a `200` allows issuance, any other response denies it.
`createOnDemandTlsAllowlist({ domains, allow?, headerName?, secret? })` builds the
Fetch-style handler for that endpoint, so an app mounts it as a JSails API route
or extension HTTP hook without reimplementing the contract. It is fail-closed: it
answers `200` only for an allowlisted hostname (exact match, case-insensitive,
trailing-dot tolerant) or when `allow(hostname)` resolves to exactly `true`, and
every other response is an empty-bodied `403` (or `400`/`405` for a malformed
request). Hostnames are never echoed.

**Security:** the app owns that endpoint. An over-permissive `domains`/`allow`
policy — one that returns `200` for a hostname it does not control — lets
certificates be issued for unauthorized domains. On-demand TLS is released in
kamal-proxy v0.10.0; Kamal's default is still v0.9.2, so a proxy image bump is
needed.

### `harden` and domain routing

`jamal harden` plans `config/harden-server.sh`; Jamal never runs it — the script
is UEFI/UFW-specific and must be reviewed and run by a human.

`jamal domain add|list|remove` controls kamal-proxy routing without re-running a
full deploy, over the same ssh path `deploy` takes. `add <host>` binds a host to
the LATEST deployed container (reconstructed from `.jamal/deploys.json`, so a
deploy must be recorded first), `remove <host>` removes the service — kamal-proxy
removes by service, so `<host>` is validated but the argv is service-scoped — and
`list` dumps the routing table. All three require `config.production`;
`--dry-run` prints the exact ssh argv without running it.

These verbs drive the proxy's runtime `deploy`/`remove` API over ssh, not
`deploy.yml`: a host added here is **not** recorded in `deploy.yml`, so a later
external `kamal deploy` may overwrite or conflict with it. Use on-demand TLS for
unknown/customer hosts; a static `production.domain` and on-demand TLS are
mutually exclusive.

## Deploy config generators

`generateDevValkeyConfig` and `generateDevDatabaseConfig` return **strings only**;
they never run Docker, `kamal`, or open a connection. Output is not deployed and
is not a complete scaffold.

- **Valkey** — pinned `valkey/valkey:8.0-alpine`, AOF persistence, no published
  6379 port. The startup script requires `VALKEY_PASSWORD` (≥32 URL-safe chars)
  and injects `requirepass` at runtime; the healthcheck authenticates via
  `REDISCLI_AUTH`. Filenames: `docker-compose.yml`, `valkey.conf`,
  `start-valkey.sh`, `.env.example`.
- **Database** — default MariaDB (`mariadb:11.4`), Postgres via
  `driver: 'postgres'`. Credentials are env references, never baked in; the app
  reads `DATABASE_*` variables individually — no connection URL is emitted.

### Generator registry

`createDeploymentGeneratorRegistry({ includeBuiltins?, generators? })` is a
neutral container over named `{ name, generate(input, context?) }` generators;
`defineDeploymentGenerator(name, generate)` is the typed helper. It includes
eight built-in adapters by default (`includeBuiltins: false` for a custom-only
registry) with deterministic ids: `valkey-dev` and `database-dev` (the local
Compose development set), `once` (the ONCE preset, below), `harden-server` (a
single `config/harden-server.sh` UFW script, reviewed and run by a human, never
executed by JSails), and `vercel-static` / `netlify-static` / `cloudflare-pages`
/ `github-pages` (one config each — `vercel.json`, `netlify.toml`,
`wrangler.toml`, and the GitHub Pages workflow — so a static export can ship to
a static host instead of a container).

`generate` returns `{ files }`; the registry validates every path as a portable
relative path — rejecting absolute/Windows-drive/UNC paths, backslashes, `..`,
`__proto__`, control characters, and file/dir collisions — and copies it into a
frozen, prototype-free map. It never writes files, touches
`node:fs`/`node:child_process`, or runs Docker, SSH, or `kamal`; the caller owns
all writing and deployment. The registry is **programmatic** — `jsails jamal`
surfaces it, but there is no `jsails generate` command and it never deploys.

## ONCE deployment preset

The opt-in built-in `once` adapter wraps `generateOnceConfig` and emits three
strings: a multi-stage `Dockerfile.once`, a `.dockerignore`, and a
`jsails.once.js` ESM wrapper around the app's real `jsails.app.js`. It is a
Basecamp ONCE preset: the image listens on port 80 (`host: '0.0.0.0'`), creates
and chowns `/storage` (and the legacy `/rails/storage`) to the `node` user, drops
to that unprivileged user, and starts the `jsails` CLI by its
`node_modules/.bin/jsails` path to `serve --config jsails.once.js`. Like the
other generators it is pure — it never writes files, runs Docker or ONCE, opens a
connection, or embeds a secret. Building the image still requires a resolvable
`jsails` dependency (published, or vendored via a `file:` tarball) and a
committed `package-lock.json`.

### Secrets and environment

ONCE injects environment variables into the container, and the wrapper maps
`BASE_URL` to `publicOrigin` conditionally. JSails does **not** use ONCE's
`SECRET_KEY_BASE`:

- **`SECRET_KEY_BASE` is never read by JSails core.** Sessions, CSRF, jobs,
  broadcast, plain page rendering, and the static export need no framework
  secret. In development/test the server-component signer mints an ephemeral key,
  and every other mode requires an explicit `signingKey` or
  `JSAILS_COMPONENT_SECRET`; the ONCE wrapper neither reads `SECRET_KEY_BASE` nor
  mutates `JSAILS_COMPONENT_SECRET`.
- **`BASE_URL` maps to `publicOrigin` only when set** — an unset `BASE_URL`
  preserves the app's own `publicOrigin`, never hardcoding one. It is consulted
  only for the same-origin `Origin` validation of cookie-authenticated mutations
  and server-component updates behind ONCE/kamal-proxy TLS termination; plain
  pages, static export, and `/up` never need it.

Set `JSAILS_COMPONENT_SECRET` (or a database/Valkey URL) through ONCE's custom
environment variables — `once deploy --env KEY=VALUE`, `once update <host> --env
KEY=VALUE`, or the TUI's Settings → Environment screen. They are stored in the
`once` Docker label and passed verbatim as `k=v`, appended last so they override
injected variables such as `BASE_URL`.

**Limitations.** The preset assumes a resolvable `jsails` dependency, no Docker
or ONCE run happens in CI, ONCE does **no** MariaDB/Valkey provisioning and
**never chowns** the mounted volume (the image creates and owns `/storage`
itself), and the preset provides no writable SQLite path.

## Next steps

- [CLI Reference](/docs/cli) — every built-in command, its flags, and the
  generator/introspection surfaces.
