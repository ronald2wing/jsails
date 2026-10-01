---
title: Introspection & AI-first Tooling
order: 15
---

# Introspection & AI-first Tooling

Agents and tooling need to read an application's shape without assembling it.
JSails exposes four read-only CLI surfaces plus one opt-in runtime endpoint that
return machine-readable state — routes, plugin enablement, the app definition,
and the request pipeline — without importing page or API modules and without
opening a connection.

All CLI surfaces are read-only and own their own subcommands and flags, so they
are routed before the shared flag-gating and never import an app config.

## `jsails inspect routes`

`inspect routes` wraps `discoverRoutes` and prints the route manifest. It never
imports page/API modules or opens a connection.

```sh
jsails inspect routes --config jsails.app.js
jsails inspect routes --config jsails.app.js --json
```

With `--json` it emits one line with resolved absolute file paths.

## `jsails plugins resolve`

`plugins resolve` wraps `loadPluginEnablement` and prints the merged enablement
from both sources — the code list and managed state. It never imports plugin
code, runs `setup`, or mutates state; the database config is consulted only when
the app is managed.

```sh
jsails plugins resolve --config jsails.app.js
jsails plugins resolve --config jsails.app.js --db-config jsails.config.js --json
```

The output carries `{ enabled, conflicts, disabledManaged, sources }`. `conflicts`
explicitly flags ids present in **both** the code list and managed state — those
ids are excluded from `enabled` and must be reported rather than silently
resolved.

## `jsails describe`

`describe` composes one machine-readable snapshot of an app's static
**definition** — no runtime state — as `{ app, routes, plugins, components,
schema }`.

```sh
jsails describe --config jsails.app.js
jsails describe --config jsails.app.js --db-config jsails.config.js --json
```

- `app` carries the resolved dirs, host, port, `healthPath`, and `publicOrigin`
  (when set).
- `routes` is `{ kind, route, dynamic, catchAll, params }` and **omits `file`**
  (no absolute paths).
- `plugins` is `{ enabled, conflicts, disabledManaged, sources }`.
- `components` is `{ name, actions, writableKeys }[]`.
- `schema` is `{ tables: [{ name, columns, indexes, uniques, foreignKeys }] }`,
  or `[]` when there are no entities or no db config.

Default config is `jsails.app.js`; `--db-config` defaults to `jsails.config.js`
and is used only to extract the entity schema via `getModelSchema()`, which
builds metadata without connecting.

Like the other surfaces it never imports page/API modules, never opens a
connection, and never runs `setup`.

## `jsails explain <path>`

`explain` resolves one request path against the discovered route manifest and
reports which route matches, its params, and the fixed request pipeline it would
traverse.

```sh
jsails explain /dashboard --config jsails.app.js
jsails explain /dashboard --config jsails.app.js --json
```

It is a pure CLI command: it never assembles an application, imports page/API
modules, or opens a connection. A path in the reserved `/_jsails` namespace
reports `reserved: true, matched: false`.

## Runtime endpoint — `GET /_jsails/introspect`

Beyond the CLI, the runtime can expose the same kind of state over HTTP through
an **opt-in, default-off, default-deny** endpoint. Configure it in
`jsails.app.js`:

```js
export default {
  introspect: {
    enabled: true,
    authorize: (context) => context.session?.role === 'admin',
    sections: ['routes', 'plugins', 'components', 'pipeline', 'config', 'health'],
  },
};
```

`authorize` is **required** when `enabled` is `true` — the loader raises a
load-time `AppConfigError` otherwise — and follows the same exact-`true`
default-deny rule as the rest of the runtime.

```sh
curl http://127.0.0.1:3000/_jsails/introspect
curl 'http://127.0.0.1:3000/_jsails/introspect?section=migrations'
```

The full valid section set is `routes, plugins, components, pipeline, config,
migrations, diagnostics, jobs, health`. The safe subset (`routes`, `plugins`,
`components`, `pipeline`, `config`, `health`) ships by default, and `sections` in
config is the **default** set returned when no `?section=` is given. An explicit
`?section=` may name **any** valid section, including the live ones, which then
report `unavailable` if no provider handles them.

Three live sections are available:

- `migrations` — `{ applied: [{ name, appliedAt }], pending: string[] }`;
  names/timestamps only, never checksums or operation JSON; `unavailable` when
  there is no data source or no tracking table.
- `diagnostics` — `stats()` counts/durations only, never raw `entries`;
  `unavailable` when the diagnostics plugin is not enabled.
- `jobs` — `{ metrics, failed: [{ id, job, failedAt, attempts, error }] }`;
  metadata only, never job payloads (`data`) or stack traces; `unavailable` when
  there is no jobs runtime.

The `pipeline` section reports the fixed stage list, the registered middleware
names, and the global middleware count. The `config` section reports a
**redacted** projection of the resolved app config — booleans for callbacks and
directory basenames only, never absolute paths, secrets, or callback identities.

Each response is an envelope of `{ generatedAt, sections: { [name]: { status,
data? | error? } } }`, with every section collected independently so one failure
never fails the rest. The endpoint never exposes secrets, session ids, CSRF
tokens, raw bodies, job payloads, or absolute filesystem paths.

## Next steps

- [Data Layer](/docs/data-layer) — entities, the portable schema, and migrations.
