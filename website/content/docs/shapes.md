---
title: Shapes
order: 31
section: Reference
---

# Shapes

A JSails project ships with a single file structure. The `shape` field in
`jsails.app.js` selects which plugins run — `'full'`, `'static'`, or `'cli'` —
without regenerating the project tree. Pages, content, components, and commands
stay where they are; live-only surfaces degrade automatically.

The model is **shapes as presets**: one `shape` field is sugar over
`plugins.use`. A shape switch is the only thing that changes which plugins are
included; the file structure is identical across shapes.

## The three shapes

```js
// jsails.app.js
export default {
  shape: 'full', // default — all plugins run
};
```

| Shape | Plugins included | Live-only plugins? | Web surface? |
| --- | --- | --- | --- |
| `full` | All plugins in `plugins.use` + `config.extensions` | Yes | Yes |
| `static` | Only plugins without `needsLive: true` | No | SSG only |
| `cli` | No web surface (`plugins.use: []`) | No | No |

`shape` defaults to `'full'`. The `--static` flag on `jsails create` scaffolds a
static-site starter that sets `shape: 'static'` with `plugins.use: []`. The
`--cli` flag scaffolds a CLI-only starter that sets `shape: 'cli'` with
`plugins.use: []`.

## How shapes work

A shape switch is a single operation: during application assembly,
`createApplication` reads each plugin's `PluginDescription.needsLive`. When
`shape` is `'static'`, every plugin that declares `needsLive: true` is excluded
from the extension list:

```
static shape → filter out plugins where describe().needsLive === true
full shape  → keep all plugins
cli shape   → no web surface (plugins.use: [])
```

The list of live-only plugins is derived from each plugin's own side-effect-free
`describe()` descriptor — never a hard-coded list. A plugin author marks their
plugin `needsLive: true` when it needs the live server (auth, jobs, broadcast,
server components); a plugin without the field runs in both shapes (content, seo,
theme, i18n, mail/cache's in-memory fallbacks).

A throwing `describe()` fails closed to `'live'` — a misbehaving plugin is never
silently kept in a static shape.

## `PluginDescription.needsLive`

The single deployment-shape axis. A boolean, not a ternary — it asks one
question: "does this plugin need the live server?"

```ts
// A live-only plugin (e.g. auth, jobs, broadcast, server-components):
definePlugin({
  name: 'my-service',
  describe: () => ({ needsLive: true }),
  setup({ services }) { /* ... */ },
});

// A plugin that runs in both shapes (e.g. content, seo, theme, i18n):
definePlugin({
  name: 'my-ssg-plugin',
  // describe() omitted — needsLive absent → runs in both shapes
  setup({ services }) { /* ... */ },
});
```

A build-time-only concern is not a runtime plugin — it belongs to the build
toolchain (`tsc`/`vite build`), a different axis than the plugin runtime surface.
A third `'static'` value for `needsLive` would abstract an empty set and blur
the boundary between the build toolchain and the runtime.

## Surface degradation

Live-only surfaces degrade automatically in a static shape — the same mechanism
that handles an absent plugin:

- **Session.** `resolveSession` is absent → every request context carries
  `session: null`. The per-route `authorize` receives `session: null` and
  denies.
- **Server components.** `serverComponentsPlugin` is excluded → no `/_jsails/
  components/update` endpoint. The static export renders only `staticFallback`
  for each component. A component without `staticFallback` throws a value-free
  error in static mode.
- **API routes.** Without the live server, API modules are discovered but never
  executed — the static export reports them as skipped.
- **Jobs / broadcast.** Excluded entirely in a static shape — no worker, queue,
  or WebSocket transport is mounted.

These degradations are not per-shape special cases; they are the ordinary
behaviour of a plugin being absent from the extension list. The runtime never
checks `shape` after assembly — it only sees which plugins are present.

## File structure never changes

Switching `shape` re-evaluates the plugin list; it never regenerates the
project. The `pages/`, `api/`, `components/`, `commands/`, `public/`, and
`content/` directories stay identical. A page that calls `loadPolymorphic`
still compiles; it resolves `null` at runtime because the data-source plugin is
absent. A page that renders a server component still compiles; the static export
renders its `staticFallback`.

This is the **one-file-structure principle**: the same project builds as both a
static site and a full application. The starter scaffolds exactly one file set
per variant; the `shape` field is the only difference between the `full` and
`static` app config templates.

## `needsLive` is not a permission

`needsLive` describes what the plugin needs to function; it is not an
authorization gate. A plugin that declares `needsLive: true` is never active in
a static shape, regardless of whether the app config lists it explicitly. The
flag answers "can this plugin run in a static export?" — nothing more.

A plugin that needs the database but not the live server (e.g. a build-time data
generator) does **not** set `needsLive: true`. It declares its database
dependency through `requires` on the data-source service token, and the static
export resolves that dependency or fails the build — the plugin author owns
that decision.

## Honest limits

- **No per-surface `requires`.** The `needsLive` flag is a single boolean per
  plugin, not a per-surface annotation. A plugin that needs the live server for
  one surface (e.g. API routes) but works statically for another (e.g. content
  collection) should split into two plugins or accept that it is excluded
  entirely in a static shape.
- **No capability-budget list.** The runtime does not enumerate which surfaces
  degrade in a given shape. The `describe`/`inspect` introspection commands
  report which plugins are live-only, and the existing null-defaults handle
  surface degradation without a separate capability model.
- **`cli` shape has no web surface at all.** The `--cli` starter ships
  `plugins.use: []` and a `tsconfig.json` without JSX/DOM. Commands work
  through both seams (discovered from `dist/commands/` or declared in
  `jsails.app.js`), but there is no `pages/`, `api/`, `public/`, or `client/`
  tree. This is not a runtime degradation — it is a different starter template.

## Next steps

- [Getting Started](/docs/getting-started) — the three starter shapes.
- [Plugins](/docs/plugins) — authoring a plugin and declaring `needsLive`.