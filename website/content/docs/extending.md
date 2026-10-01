---
title: Extending JSails
order: 9
---

# Extending JSails

JSails is extended through a single seam: the **extension**. An extension is a
plain object — not a class, not a global registration — that provides services,
registers HTTP hooks, and returns a cleanup. Everything above the substrate is
plugin-shaped, and a **plugin** is just an extension that can be packaged,
discovered, and installed.

Import from **`jsails/extensions`** for an ORM-free entry (Hono is referenced
through `import type` only). The root `jsails` entry re-exports the same symbols
but pulls in `reflect-metadata` and TypeORM.

## The extension seam

An extension is `{ name, requires?, provides?, priority?, setup(context) }`.
Names must be non-empty and unique — a duplicate errors before any `setup` runs.
`setup({ services, configureHttp, configureMiddleware, onServe })` may return a
cleanup function (or a promise of one).

- `createServiceToken<T>(name)` makes an opaque typed token. Identity is the
  token object itself, not its name, so define each token **once** and share it
  between providers and consumers. `name` is a diagnostic label only.
- Services are per application: `runExtensions([...])` (or `createApplication`)
  builds a fresh registry. There is no global registry and no cross-app sharing.
- `requires` lists service tokens that must already be registered by an
  **earlier** declared extension; a missing requirement fails before `setup`.
- `priority` orders the setup phase: within a topological layer, lower priorities
  run first, and ties keep declaration order. It defaults to `0`.
- Cleanups run in **reverse** declaration order on `close()`. If a `setup`
  throws, already-completed extensions are cleaned up and the registry cleared.
  An extension that throws before returning its teardown **owns the cleanup of
  whatever it partially created** — return the teardown as soon as resources
  exist so a later failure can dispose of them.

```js
// jsails.app.js  (app-owned, compiled ESM; plain default export)
import { createServiceToken } from 'jsails/extensions';

// Token defined once, shared by the provider and the consumer.
export const clock = createServiceToken('clock');

const clockExtension = {
  name: 'clock',
  setup({ services }) {
    services.provide(clock, { now: () => new Date().toISOString() });
  },
};

const healthExtension = {
  name: 'health',
  requires: [clock], // provided by the earlier "clock" extension
  setup({ services, configureHttp }) {
    const { now } = services.get(clock);
    configureHttp((app) => {
      // Native Hono route; this hook owns its own authorization.
      app.get('/healthz', (c) => c.json({ ok: true, at: now() }));
    });
  },
};

export default {
  rootDir: '.',
  out: 'out',
  extensions: [clockExtension, healthExtension],
};
```

## HTTP and middleware hooks

`configureHttp(hook)` collects native Hono hooks, once, in declaration order.
Hooks are trusted application code: routes they add own their own security and
are **not** covered by the filesystem default-deny API pipeline.

`configureMiddleware(handler)` registers a global middleware handler that runs
before every filesystem page and API route. Handlers are collected in setup
registration order and frozen after setup; the server layer composes them ahead
of per-route middleware. Both `configureHttp` and `configureMiddleware` are only
valid while `setup` is running — calling either afterwards throws.

## Substrate vs. plugin boundary

Not everything can be an extension. The **substrate** is everything upstream of
`runExtensions` — the code that must run *before* any extension can exist: the
CLI entry and command dispatch (`src/cli.ts`), the app config loader
(`loadAppConfig` / `validateAppConfig`), the extension runner itself
(`runExtensions`) and the service registry, route discovery (`discoverRoutes`),
and pure plugin enablement (`resolvePluginEnablement` / `loadPluginEnablement`).

An extension cannot run itself, so these stay in core. Everything **above** that
line — HTTP hooks, services, commands, pages, admin surfaces, first-party
features like auth/blog/jobs — is plugin-shaped and can be declared as an
extension.

The read-only introspection commands (`inspect`, `describe`, `explain`) are
deliberately **substrate**, not an `introspect` plugin: they are early-routed
*before* config loading and own their own `--config` flag, so they work from any
cwd with no app config. Their names are reserved
(`DEFAULT_RESERVED_COMMAND_NAMES`) so a user command cannot be silently shadowed
by the early routing.

## Contract tokens

A **contract token** is a typed capability declaration with replacement
semantics — distinct from a service token, not a flag on it.
`createContractToken<T>(name, { version? })` produces a token whose `version`
defaults to `1` and must be a positive integer; each call is a distinct identity
even when `name` repeats.

An extension declares the contracts it fulfills in `provides` and the ones it
reads in `requires`. When one extension provides a contract and another requires
it, the provider is guaranteed to run before the consumer regardless of
declaration order — the runner topologically sorts over these edges, then
`priority` lowest-first, then declaration order. Service tokens in `requires`
are still checked inline; they do not affect ordering.

At most one non-override provider plus at most one override is permitted per
contract. A `provides` entry with `override: true` replaces an earlier default
provider — the override's implementation wins in the registry. Zero providers
for a required contract, or two non-override providers, fails value-free at load
time.

## Plugins

A **plugin** is a packageable extension: `JsailsPlugin` extends `JsailsExtension`
with declarative passthroughs (`deployments`, `renderer`) carried by identity for
the config loader, and a `PluginContext` whose `setup` can additionally register
interceptors and observers. `priority`, `disabled`, `requires`, `provides`, and
`commands` are inherited, so a plugin participates in the same contract-ordered
setup phase as every extension. `definePlugin(plugin)` is an identity helper that
keeps the `setup` context typed as `PluginContext` even when the literal is
nested inside a `JsailsExtension[]`.

A plugin may carry an optional `describe?: () => PluginDescription` — a pure,
side-effect-free declarative descriptor readable **without** running `setup`. It
never invokes callbacks, signs snapshots, or performs I/O. `PluginDescription`
currently carries `components` and `commands`; both `jsails describe` and the
introspect `components` section read component metadata through it without
materializing a runtime.

### Declaring plugins

`plugins.use` in `jsails.app.js` lists plugins to load, each a specifier or a
`[specifier, options]` tuple. The loader imports the module's default export and
calls it with the options; a module whose default export is already a
`JsailsPlugin` object is accepted as-is. Every plugin a specifier names
automatically runs — developer plugins are never gated by `enabled`.

```js
export default {
  plugins: {
    use: [
      'jsails/plugin-tools',
      ['jsails/auth', { publicOrigin }],
      ['jsails/filesystem', { disks: { local: createLocalDisk({ root: 'storage/files' }) } }],
    ],
    enabled: ['plugin-tools', 'auth', 'filesystem'],
    managed: true,
  },
};
```

### Two-source enablement

A plugin id is enabled by either of two independent sources, merged
deterministically by `resolvePluginEnablement({ codeEnabled, state })`:

- **Code list.** `plugins.enabled` names the npm plugins enabled out of the box.
  Installing an npm plugin that self-identifies through its `package.json`
  `jsails` field is activating it, so the code list is the source of truth for
  dependency plugins.
- **Managed state.** A `PluginStateSource` — either the `<pluginsDir>/state.json`
  `PluginStateStore` document (`{ version, plugins: { [id]: { active, enabled } } }`,
  written by the admin) or the database-backed store — records what the admin
  installed and toggled. Every id whose `enabled` is `true` is enabled.

`plugins.enabled` also gates the built-in `config.extensions` at runtime by name:
an extension whose `name` is not listed is skipped before its `setup` runs.

`loadPluginEnablement({ codeEnabled, managed, stateSource })` is the
managed/non-managed switch: a **non-managed** deployment (`managed !== true`)
performs no state I/O and resolves code-only enablement, while a **managed** one
requires a state source, loads it, then merges it with the code list. The static
export is always non-managed.

The result is frozen and deterministic: `enabled` is the sorted union of the code
list and every state id with `enabled === true`; `conflicts` lists ids present in
**both** sources, which are **excluded** from `enabled` and must be reported by
the caller (fail closed — a conflict is a configuration error, never silently
resolved). `disabledManaged` lists state ids turned off that are not
code-enabled; those ids — and any id that is not installed — are skipped, not
enabled.

### The manifest

A plugin package or bundle declares a `manifest.json` so the framework can
discover, check, and activate it without importing any plugin code. The manifest
is validated with Zod and then checked for semver soundness; `parsePluginManifest`
throws a value-free `PluginManifestError` whose messages never echo input. The
schema is strict — unknown fields are rejected rather than ignored.

```json
{
  "id": "acme-blog",
  "version": "1.2.0",
  "jsailsCompat": ">=0.1.0 <1.0.0",
  "permissions": ["blog.read", "blog.write"],
  "plugins": [{ "id": "acme-core", "range": "^1.0.0" }],
  "settingsSchema": { "apiKey": "string" },
  "entry": "./dist/plugin.js",
  "checksums": { "acme-blog-1.2.0.tgz": "sha256-..." },
  "signature": "..."
}
```

`id` must match `PLUGIN_ID_PATTERN` (a lowercase/digit start followed by
lowercase letters, digits, `.`, `_`, or `-`); `version` and `jsailsCompat` must
be valid semver; `permissions` and `plugins` default to `[]`; `settingsSchema`,
`checksums`, and `signature` are optional. `entry` is a bare module specifier
(imported directly) or a relative path (resolved against the package directory).

### Discovery, installer, and activation

The plugin system lives in `src/plugins/` (exported as `jsails/plugins`): the
manifest contract, two-source discovery, the framework-version check, the `.tgz`
extractor, the persisted state store, the enablement merge, download-capability
resolution, the installer, and activation.

- **Discovery** (`discoverPlugins`) walks the two origins without importing any
  plugin code: the direct npm `dependencies` of the app package (each dependency
  that self-identifies through its own `package.json` `jsails` field) and the
  storage-backed plugins folder (each `manifest.json` bundle). It is synchronous
  and filesystem-only, follows no symlinks, and never evaluates a module.
- **Installer** (`createPluginInstaller`) downloads a `.tgz` bundle, verifies an
  optional SHA-256 checksum and detached signature, extracts it into a private
  staging directory, validates the embedded manifest against the requested
  id/version, then atomically renames it into `<pluginsDir>/<id>/<version>/` and
  records the active version. It never evaluates plugin code, and every failure
  raises a value-free `PluginInstallerError`.
- **Activation** (`activatePlugins`) is the one slice that imports plugin code.
  It resolves the enabled ids, discovers the matching plugins, and dynamically
  imports each entry module — executing trusted plugin top-level code at import
  time. It structurally validates the exported plugin object(s) but **never
  calls `setup`**; the extension runner does that later.

**`activatePlugins` is an exported, opt-in capability — it is not wired into
`createApplication`.** The runtime's boot path does not discover or dynamically
import plugins: `createApplication` runs the extensions the app config declares
directly (`config.extensions`), gated by name through `plugins.enabled`. A
deployment that wants discovery-driven activation calls `activatePlugins` itself
and feeds the returned `plugins` into its extension list. This keeps the default
boot path free of dynamic imports and managed-state I/O.

### Managed state

A managed deployment (`plugins.managed: true`) can persist plugin state in the
application's database instead of the `<pluginsDir>/state.json` document. The
table is **framework-owned**: the `JsailsPluginState` entity maps to
`jsails_plugin_state` with a generated integer primary key and four scalar
columns — `pluginId` varchar(190), `activeVersion` varchar(64), `enabled`
boolean, `updatedAt` datetime. An app opts in by adding `pluginStateEntities` to
its `JsailsDataSource` `entities` and running the normal history:

```js
// jsails.config.js  (app-owned; plain ESM)
import { JsailsDataSource, pluginStateEntities } from 'jsails';
import { User } from './entities/user.js';

export default new JsailsDataSource({
  type: 'mariadb',
  /* ... */
  entities: [...pluginStateEntities, User],
});
```

```sh
jsails makemigrations --name add_plugin_state --config jsails.config.js
jsails migrate --config jsails.config.js
```

`createDatabasePluginStateStore({ dataSource })` reads and writes that table
through the injected data source's **repository** — no raw SQL and **no runtime
DDL**. The table must already exist: a missing table fails with a clear,
value-free error telling the caller to run `makemigrations`/`migrate`; the store
**never creates it**. The migration history is the only path that creates the
table, so its schema is recorded and diffed like every other entity.

## Next steps

- [Jobs](/docs/jobs) — the provider-neutral job runtime, metrics, and the
  failed-job store.
