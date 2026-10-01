---
title: Symbols & Autoload
order: 14
section: Extending
---

# Symbols & Autoload

The symbols subsystem makes framework exports available without explicit
imports. A JSails author writes `class Post extends ApplicationRecord` or
`const job = defineJob(...)` with no import — TypeScript type-checks those
identifiers against the generated `.jsails/framework-symbols.d.ts`, and the
emitted JavaScript resolves them against `globalThis`. The CLI installs the
framework symbols before any app module evaluates; the client bundle installs
the browser-safe subset before island hydration.

The same mechanism injects **project symbols** — your own models, jobs, commands,
and other autoloadable project code — at compile time, so the ergonomics extend
past the framework boundary.

## Two halves: framework symbols and project symbols

| Kind               | Source                         | Installed by                      | When                  |
| ------------------ | ------------------------------ | --------------------------------- | --------------------- |
| Framework symbols  | Derived at `build:meta`        | `installFrameworkSymbols(rootDir)`| CLI bootstrap         |
| Project symbols    | Compiler injects shim imports  | `installProjectSymbols(rootDir)`  | After framework, before any app module |

Framework symbols are a property of the framework itself: a static scan of every
public subpath's barrel enumerates the value exports and classifies each subpath
as `server` or `both` (browser-safe). The scan runs at the app's `build:meta`
step and emits `.jsails/framework-symbols.js` (the runtime table) beside the
already-emitted `.jsails/framework-symbols.d.ts`. The table is derived per app,
never checked in — so it can never drift from the barrels it describes.

The declaration — which subpaths project — is resolved at `build:meta` from the
**curated framework declaration** (`FRAMEWORK_SYMBOL_DECLARATION`): by default,
nothing projects, and the framework opts in the authoring surface (`models`,
`database`, `server-components`, `jobs`, `support`, …) through a hand-maintained
`selected` list. A plugin declares its own surface the same way and defaults to
`none` — a global is never created by accident.

Project symbols are built by the compiler: for every autoloadable project file
(a model class, a job definition, a command), the compiler emits a thin shim that
imports the real module and assigns its exports onto `globalThis`.
`installProjectSymbols` imports the generated `.jsails/project-symbols.js`, which
dynamically imports every shim in dependency order.

## `installFrameworkSymbols`

```ts
import { installFrameworkSymbols } from 'jsails/symbols';

await installFrameworkSymbols(rootDir);
// Every framework global is now on globalThis.
```

This function imports the app's generated `.jsails/framework-symbols.js` (written
by `build:meta`) and assigns the named exports onto `globalThis`. When the file
is absent — the project has not run `build:meta` — the call returns silently, the
same contract as `installProjectSymbols`. It is `async` because ESM has no
synchronous module-load hook — the installer must be awaited before any app
module evaluates. The call is idempotent: a repeated call re-imports (module
cache makes it cheap) and reassigns the same values.

### Collisions

When more than one entry in the catalog declares the same bare name, the first
entry in table order wins the bare slot. Every distinct subpath whose symbols
collide additionally gets a **namespace object** installed on `globalThis` under
a key derived from the subpath's last path segment (e.g. `jsails/content` →
`globalThis.content`), so a colliding symbol stays reachable as
`content.readingTime`.

### Override warnings

A bare name whose slot already holds a *different* value is replaced, but first
a `FrameworkSymbolOverrideWarning` is emitted (via `console.warn` by default)
naming what was lost (`from`) and what won (`over`). An identical re-install is
silent. The installer never throws on an override.

### Missing symbols

When a declared symbol is not exported by its subpath, the installer throws a
value-free error — that is a framework bug, not a user error.

## `installProjectSymbols`

```ts
import { installProjectSymbols } from 'jsails/symbols';

await installProjectSymbols(process.cwd());
// Every project symbol is now on globalThis.
```

Imports the generated `<rootDir>/.jsails/project-symbols.js`. When the file does
not exist (the project has no autoloadable symbols, or has not run the compiler),
the call returns silently — no error, no warning. When the file exists but its
imports reference missing compiled modules (a `rm -rf dist` after a build),
Node's `ERR_MODULE_NOT_FOUND` is reframed as a `SymbolsInstallError` with code
`stale_project_globals` and an actionable message telling the operator to rebuild.

Every other failure (a syntax error in a real module, a transitive import error)
propagates unchanged.

## Browser counterpart: `jsails/symbols/client`

```ts
import { installBrowserSymbols } from 'jsails/symbols/client';

await installBrowserSymbols();
// Browser-safe framework globals are on globalThis.
```

The browser installs only the browser-safe subpaths — those whose
`BROWSER_SAFE_SUBPATHS` declaration marks them `both`. A subpath classified
`server` is never projected into the bundle, so it can never drag a server-only
dependency (TypeORM, BullMQ, Hono's node server) into the client graph.

The browser projection uses **literal import thunks** — a static map of
`'jsails/api': () => import('../api/index.js')` — so the bundler can
statically follow each import and include only the browser-safe subpaths. The
map is the single source of truth for which subpaths project in the browser, and
the projected table is derived from each loaded module's own export names.

The projection rules (collisions, namespace objects, override warnings,
missing-symbol throw) are the same as the server projection — one
environment-agnostic engine (`projectFrameworkSymbols`) is shared by both, so a
name resolves the same way in both targets.

## `SymbolsInstallError`

```ts
import { SymbolsInstallError } from 'jsails/symbols';

try {
  await installProjectSymbols(rootDir);
} catch (error) {
  if (error instanceof SymbolsInstallError && error.code === 'stale_project_globals') {
    // Rebuild: `jsails build:meta`
  }
}
```

A value-free error with one code (`stale_project_globals`) raised when the
generated `project-symbols.js` references compiled modules that are missing. The
message names the generated file and tells the operator to rebuild; the
underlying `ERR_MODULE_NOT_FOUND` is accessible through `cause`.

## `framework-symbols.d.ts`

The compiler emits `.jsails/framework-symbols.d.ts` — an ambient declaration
file declaring every framework symbol plus project autoload symbols. TypeScript
reads it through the project's `tsconfig.json` `include` (the generated
`.jsails/` directory is included by the starter's tsconfig). The declaration is
the only place the bare names are declared; the runtime globals are the same
names on `globalThis`.

## Relationship to the `autoload` compiler plugin

The `autoload` compiler plugin (which lives in the compiler, not in
`jsails/symbols`) discovers autoloadable project files at build time and emits
the shims that `installProjectSymbols` imports. The symbols subsystem is the
**runtime installer** — it publishes the discovered symbols onto `globalThis`.
The autoload plugin is the **compile-time discovery** — it finds what to
install. Together they make project symbols import-free without a manual
registry.

## Honest limits

- Plugin-symbol installation is deferred. Third-party plugin symbols are
  installed at app assembly time (a later wave), not at CLI bootstrap; only the
  framework table is installed by `installFrameworkSymbols`.
- The framework table requires `build:meta`. Without it, `installFrameworkSymbols`
  installs nothing (a silent no-op, like `installProjectSymbols`) — the project
  relies on explicit imports.
- No token install. Operation and event tokens are resolved internally by the
  name-to-token registry; consumers reach `intercept` (an autoloaded framework
  global) and pass a string. Tokens are never installed on `globalThis`.
- The server installer imports `node:fs`/`node:path`/`node:url` — it is
  server-only and must never reach the browser-safe graph. The browser installer
  shares the projection engine (`projection.ts`) which is environment-agnostic.
- No synchronous lazy getters. A `globalThis` accessor cannot synchronously
  `import()`, so the installer loads the whole curated set once, up front. The
  set is bounded (each subpath is a barrel the process would load anyway).

## Next steps

- [Extending JSails](/docs/extending) — the extension seam.
- [Server Components](/docs/server-components) — signed, stateful components with
  backend actions.
