---
title: Extending JSails
order: 13
section: Extending
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
`runExtensions` — the code that must run _before_ any extension can exist: the
CLI entry and command dispatch (`src/cli/index.ts`), the app config loader
(`loadAppConfig` / `validateAppConfig` in `src/app/config/load.ts`), the extension
runner itself
(`runExtensions`) and the service registry, route discovery (`discoverRoutes`),
and pure plugin enablement (`resolvePluginEnablement` / `loadPluginEnablement`).

An extension cannot run itself, so these stay in core. Everything **above** that
line — HTTP hooks, services, commands, pages, admin surfaces, first-party
features like auth/blog/jobs — is plugin-shaped and can be declared as an
extension.

The read-only introspection commands (`inspect`, `describe`, `explain`) are
deliberately **substrate**, not an `introspect` plugin: they are early-routed
_before_ config loading and own their own `--config` flag, so they work from any
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

## Overrides, interceptors, and the signal bus

Overrides work differently in different parts of the framework, and that asymmetry is deliberate:

- **Extensions always run.** App-declared `config.extensions` and `plugins.use`
  entries run in full; `plugins.enabled` is a marketplace/managed-only gate for
  admin-installed plugins, never a boot-time filter over developer extensions.
- **Services override; registries are add-only.** `provide(token, value,
{ replace: true })` overwrites a registration (a duplicate without the flag
  throws); a contract has one dedicated override provider; theme tokens fold by
  precedence with application tokens winning highest. Admin
  pages/resources/widgets/charts/notices enforce uniqueness with no override
  API, and routes/pages/API are additive — a health-path collision is a hard
  error.
- Interceptors follow a narrow subset of the Magento 2 model. `before`, `after`, and `observe` run on explicitly defined operation tokens: `before` mutates args in place with no short-circuit, `after` transforms the result in reverse order, and `observe` is fire-and-forget. There is no `around` hook, no method-level AOP weaving, and no generated interceptor classes. Only the first-party blog plugin uses interceptors.
- Signals share the WordPress observer model but deliberately omit filters. `SignalBus.observe` and `emit` provide a shared, fire-and-forget, error-isolated bus over a fixed set of event tokens (requests, jobs, and logging). There is no `apply_filters`-style value-filter registry — no priority-ordered callback chain that transforms a framework value in transit. There is no runtime `add_action` after the registry seals, and no dynamic per-listener priority outside `setup`.

The trade is deliberate: JSails exchanges ambient power for compile-time clarity
— capabilities exist only where explicitly authored, and only enumerate during
`setup`. It is neither a Magento aspect weaver nor a WordPress hook system.

## Next steps

- [Plugins](/docs/plugins) — packaging, discovering, and installing extensions.
- [Symbols & Autoload](/docs/symbols) — the generated autoload layer.
- [Admin Panel](/docs/admin) — the first-party admin surface.
