---
title: Plugins
order: 15
section: Extending
---

# Plugins

A plugin is a packageable extension that can be discovered, installed, and enabled.

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

## Declaring plugins

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
      ['jsails/filesystem', { disks: { local: new LocalDisk({ root: 'storage/files' }) } }],
    ],
    enabled: ['plugin-tools', 'auth', 'filesystem'],
    managed: true,
  },
};
```

## Two-source enablement

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

`plugins.enabled` is a marketplace/managed-only gate: it controls admin-installed
plugins, never app-declared `config.extensions` (or `plugins.use` entries), which
always run in full at boot time.

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

## The manifest

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

## Discovery, installer, and activation

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
directly (`config.extensions` and `plugins.use`), always in full —
`plugins.enabled` is a marketplace/managed-only gate for admin-installed plugins,
never a boot-time filter. A
deployment that wants discovery-driven activation calls `activatePlugins` itself
and feeds the returned `plugins` into its extension list. This keeps the default
boot path free of dynamic imports and managed-state I/O.

## Managed state

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
jsails db:push --config jsails.config.js
```

`createDatabasePluginStateStore({ dataSource })` reads and writes that table
through the injected data source's **repository** — no raw SQL and **no runtime
DDL**. The table must already exist: a missing table fails with a clear,
value-free error telling the caller to run `jsails db:push`; the store
**never creates it**.

## Next steps

- [Admin Panel](/docs/admin) — the first-party admin surface.
- [Extending JSails](/docs/extending) — the extension seam.
