# Autoload Everything (Server + Client + SSG) — Implementation Plan

**Status:** approved design · not yet implemented
**Date:** 2026-10-13
**Directive:** do it right, not easy; no backward-compat constraints; the user
writes JSails, never TypeORM; no imports for framework or project symbols.

## 1. Goal

Make **every** symbol autoload — no `import` statements for framework symbols
(`ApplicationRecord`, `defineJob`, `defineModel`, `defineMetadata`, …) or for
project symbols (a model referencing another model, a page referencing a
component) — across **all three** compilation paths:

1. **Server tree** — compiled by `tsc -p tsconfig.json` (Node ESM).
2. **Client tree** — bundled by Vite (browser ESM).
3. **SSG tree** — the static starter, whose feed script is a plain `.mjs` run by
   Node (not `tsc`-compiled).

After this work, a starter model file is:

```ts
// models/post.ts — no imports at all
class Post extends ApplicationRecord {
  declare title: string;
  declare author: Author;          // bare project symbol
  declare comments: Comment[];     // bare project symbol
}
```

and a page is:

```ts
// pages/index.tsx — no imports at all
export const metadata = defineMetadata({ title: 'Home' });
export default function Home() { return <Layout><Counter /></Layout>; }
```

## 2. Non-goals

- **No `tsc` replacement.** `tsc` stays the server compiler (decorator metadata
  + Node ESM semantics are load-bearing). We do not introduce `ts-patch`,
  `ttypescript`, or a custom transformer.
- **No user-source mutation.** The codemod (client) and the shim tree (server)
  never rewrite a file the user authored.
- **No runtime module interception.** ESM has no hook; autoload is a
  compile-time + preload-time mechanism, not a runtime loader.
- **No new dependencies.**

## 3. Spike results (all proven in this session)

| # | Question | Result | Consequence |
|---|---|---|---|
| S1 | Does a bare identifier resolve to a `globalThis` property in Node ESM? | **Yes, if the global is installed before the module evaluates.** No preload → `ReferenceError`; `node --import ./preload.mjs` → resolves. | Server autoload = install globals at process start. |
| S2 | Does `tsc` typecheck `class Post extends X` when `X` is ambient (no import)? | **Yes** — but a `declare const X` alone is a *value*, not a *type* (`TS2749`). | Generator must emit **both** a value side and a type side per symbol. |
| S3 | Does the split `declare const X: typeof import(...).X; declare type X = import(...).X;` typecheck? | **Yes, exit 0.** | This is the ambient declaration shape. |
| S4 | Does `tsc` **emit** a bare reference (not an injected import) for an ambient symbol? | **Yes** — emits `class Post extends ApplicationRecord {}` and `new Author()` verbatim. | No codemod needed for the server; emitted JS resolves via `globalThis`. |
| S5 | Does a shim-chain (each shim imports its deps' shims, then the real module) fix evaluation order? | **Yes.** Negative control (shim without its dep) throws `ReferenceError`. | Ordering is load-bearing; the shim graph must be topologically ordered. |
| S6 | Is the starter `tsc` incremental? | **No** — `tsconfig.json.template` has no `incremental`/`tsBuildInfoFile`. | No shadow-tree/incremental hazard for apps; a shim tree is cheap. |
| S7 | Which directories are compiled by both `tsc` and Vite? | **`ui/` only.** Server-only: `pages/ api/ app/ models/ jobs/ extensions/ commands/`. Client-only: `client/`. | `ui/` needs **both** mechanisms; everything else needs exactly one. |

## 4. Architecture

Two mechanisms, chosen per compilation path. They are complementary, not
redundant.

### 4.1 Server tree → **globals + ambient types** (no codemod)

`tsc` preserves bare references (S4). So the server needs only:

1. **Runtime globals** installed before any app module evaluates (S1).
2. **Ambient type declarations** so `tsc` typechecks the bare names (S2/S3).

No source rewriting, no shadow tree, no custom transformer. This is strictly
simpler than the codemod and is the correct tool for a `tsc`-compiled tree.

**Runtime install.** The CLI entry (`src/cli/index.ts`) is the process start for
`serve`/`build`/`dev`/`test`. It installs the global registry via a single
`--import`-equivalent side effect at the top of the bootstrap, before any app
module is imported. The registry is **lazy per symbol** (getter that imports on
first access) so cold start does not pull the whole framework graph.

**Ambient types.** `generate-meta.ts` already emits `.jsails/jsails-global.d.ts`
(sixth artifact). Extend it to declare, for every framework symbol in the global
set, the split value+type pair (S3):

```ts
declare const ApplicationRecord: typeof import('jsails/models').ApplicationRecord;
declare type ApplicationRecord = import('jsails/models').ApplicationRecord;
```

The starter `tsconfig.json` already `include`s `.jsails/jsails-global.d.ts`.

### 4.2 Project symbols on the server → **shim tree** (`.jsails/shims/`)

A model referencing `Author` (another model) cannot be a framework global — the
symbol is project-owned. The server resolves it via a generated **shim tree**
whose path mirrors the source tree under `.jsails/shims/`:

```
.jsails/shims/models/author.js  →  import { Author } from '../../../dist/models/author.js';
                                   globalThis.Author = Author;
.jsails/shims/models/post.js    →  import './author.js';            // dep shim first
                                   import { Post } from '../../../dist/models/post.js';
                                   globalThis.Post = Post;
.jsails/globals.js              →  import { installFrameworkGlobals } from 'jsails/globals';
                                   await installFrameworkGlobals();
                                   await import('./shims/models/author.js');
                                   await import('./shims/models/post.js');
```

Specifiers resolve to the **compiled** tree (`dist/`, three levels up to the
project root from `.jsails/shims/<dir>/`), not the TypeScript sources.

Each shim imports its **dependencies' shims first**, then the real module, then
publishes the global (S5). `.jsails/globals.js` imports the shims
**dynamically and sequentially** so the framework install (and each awaited
top-level-await provider) completes before the next shim evaluates. The CLI
preloads `.jsails/globals.js` before app modules. The shim graph is
topologically ordered from the same dependency edges the codemod already
computes.

**Why a shim tree and not a codemod for the server?** A codemod would rewrite
user sources (forbidden) or require a shadow tree (unnecessary — S6 shows the
starter is not incremental, and the framework's own incremental build is
untouched). The shim tree is generated, disposable, and never collides with user
files.

### 4.3 Client tree → **codemod** (existing Vite plugin, widened)

The client is bundled by Vite, where `globalThis` assignment defeats
tree-shaking and the browser has no preload hook. The existing
`src/compiler/autoload-plugin.ts` transform already injects real imports into
the module graph. **Widen it** to cover the full client-reachable set and keep
it codemod-only (no globals on the client).

### 4.4 `ui/` — the dual-compiled directory

`ui/` is in both tsconfigs (S7). It is compiled by `tsc` (server) **and** Vite
(client). Therefore `ui/` files get **both** treatments: the shim tree covers
their server compilation, the codemod covers their client compilation. This is
the only directory where both mechanisms apply, and it is why both must exist.

## 5. Workstream A — Autoload everything (server + client)

### A1 — Framework-symbol global registry

- Extend `src/internal/jsails-namespace.ts` from the `jsails` decorator
  namespace into a **flat lazy global registry**: `globalThis.ApplicationRecord`,
  `globalThis.defineJob`, `globalThis.defineModel`, `globalThis.defineMetadata`,
  `globalThis.defineContentCollection`, and the rest of the framework's
  `create*`/`define*` authoring surface.
- Each symbol is installed via an import-on-first-access getter (lazy — no
  cold-start bloat; matches the CLI lazy-bootstrap discipline).
- Extend `generateJsailsGlobalDts` (`src/compiler/jsails-global-dts.ts`) to emit
  the split value+type declaration (S3) for every symbol in the set.
- **Verify:** `test/internal/jsails-namespace.test.ts` (lazy install, no eager
  import), `test/compiler/jsails-global-dts.test.ts` (split decl shape).

### A2 — Server shim-tree generator

- New `src/compiler/autoload-shims.ts`: reuse `scanAutoload` +
  `injectAutoloadImports`'s dependency edges over the **whole server tree**;
  emit `.jsails/shims/*.js` + `.jsails/globals.js`, topologically ordered (S5).
- Widen `AUTOLOADABLE_PREFIXES` (`src/compiler/conventions.ts`) to cover
  `app/composables/`, `app/utils/`, `server/`, `shared/`, `models/`, `ui/`,
  `jobs/`, `commands/`, `extensions/`, `components/`. **`pages/` and `api/` are
  consumer-only** — they are not providers and get no shims (deviation from the
  original `N1_DIRECTORIES` sketch, which listed them).
- Write-if-changed (hash-manifested) so repeated builds are stable.
- **Verify:** `test/compiler/autoload-shims.test.ts` (ordering, dep-first,
  write-if-changed, no user-source mutation).

### A3 — Wire into the build

- `build:meta` (`src/cli/meta-commands.ts`) emits the shim tree alongside the
  existing artifacts.
- CLI bootstrap preloads `.jsails/globals.js` before app modules for
  `serve`/`build`/`dev`/`test`.
- Starter `package.json` scripts already run `jsails build:meta` first — no
  script change needed beyond confirming the preload path.
- **Verify:** `test/cli/meta-commands.test.ts`; starter `test/app/starter.test.ts`.

### A4 — Ambiguity discipline

- Same-context duplicate names = hard, value-free error (inherit the Vite
  plugin's rule). Shadowed locals are never injected (the scope-walker already
  handles this).
- **Verify:** `test/compiler/autoload-shims.test.ts` (duplicate → error).

## 6. Workstream B — SSG autoload

**Status: implemented (B1–B4).** The locked design, as shipped:

- The static starter (`templates/starter-static/`) gets the same shim tree +
  globals for its `tsc`-compiled tree. `build`/`typecheck` prepend
  `jsails build:meta &&`; the feed step preloads the generated globals.
- **"No imports" applies to consumers, not providers.** Pages and the feed
  script reference project symbols bare; providers (`ui/layout.tsx`,
  `server/content.ts`) keep explicit relative imports for their own internal
  wiring. A shim dep edge exists only when a provider *bare-references* another
  provider's symbol.
- **Directory homing:** the old `app/content.ts` → **`server/content.ts`**
  (server context; it uses top-level await and `jsails/content`), and the old
  `app/site.ts` → **`shared/site.ts`** (app context). `app/` (bare) is
  deliberately **not** autoloadable — the web starter's `app/application-*.ts`
  shims must not be server-preloaded.
- **`site` double-export hazard:** `server/content.ts` no longer re-exports
  `site`; `shared/site.ts` is the sole provider of `site`, so no
  `ambiguous_symbol`.
- **Framework authoring entry points are globals:** `defineContentCollection`,
  `defineTaxonomies`, `defineContentVersions`, `defineSections` are in
  `FRAMEWORK_GLOBALS`, so `server/content.ts` uses them bare. Third-party
  packages (`zod`) stay explicit imports.
- **Interface-only exports are not autoload symbols:** `type LayoutAssets` is
  interface-only, so pages keep `import type { LayoutAssets } from
  '<rel>/ui/layout.js'` while value imports are stripped.
- **Feed script:** `node --import ./.jsails/globals.js scripts/generate-feeds.mjs`
  — a plain `.mjs` run by Node, not `tsc`-compiled, so it uses the preload path.
- **Verify:** `test/compiler/autoload-e2e.test.ts` proves a top-level-await
  provider is awaited and published to a cross-context consumer (the exact SSG
  shape); `test/app/starter.test.ts` asserts the static file set, config
  templates, and bare-symbol usage. A full SSG build (emitting
  `sitemap.xml`/`robots.txt`) needs installed deps and belongs in
  `verify:starter`, not the unit suite.

## 7. Workstream C — SEO (`jsails/seo`)

Execute `docs/superpowers/plans/2026-10-13-jsails-seo.md` unchanged in intent:
add the `./seo` subpath + `src/seo/` barrel, `PageMetadata`/`defineMetadata`,
`metadata`/`generateMetadata` page exports, `renderSSRHead()` + `injectHead`
splice, JSON-LD, `buildSitemapXml`/`buildRobotsTxt`, build-time
`sitemap.xml`/`robots.txt`, admin `noindex`, starter demo. After autoload,
`defineMetadata`/`jsonLd` become bare globals.

## 8. Sequencing

**A → B → C**, each its own quartet. A and B share the shim machinery but B is a
distinct scan root + `.mjs` global path, so it is a separate verifiable unit.

## 9. Verification quartet (per workstream)

`npm run build:clean` → `npm run check` → `npm run verify:starter -- --skip-browser`
→ `npm run format` → `npm run lint` → `node scripts/check-src-structure.mjs` →
`npm run build` + `npm --prefix website run check`.

Baseline: `npm run check` = 6317 tests / 6316 pass / 0 fail / 1 skipped.
Invariant = **0 fail**.

## 10. Open sub-decisions (resolve during implementation, not gospel)

- Exact lazy-getter shape for the framework global set (per-symbol getter vs a
  single lazy proxy) — pick whichever keeps cold start flat.
- Whether the shim tree lives under `.jsails/shims/` or a sibling `.jsails/`
  subdir — cosmetic; `.jsails/shims/` is the default.
- `defaultInverse(name)` fallback in `define-model.ts` (carried, non-blocking).

## 11. The unified name-resolution registry (supersedes the earlier wave sketch)

**Status:** approved design · not yet implemented. This section **supersedes**
the 8-wave draft in `/tmp/opencode/autoload-everything-plan.md` (ephemeral) and
extends Workstreams A/B above.

### 11.1 The unifying insight

Reaching a framework function, reaching a project symbol, and **finding a hook
point** are the same problem: *a name that resolves without an import,
disambiguated by plugin namespace on collision.*

| Concern | Key today | Under this design |
|---|---|---|
| Reach a framework authoring verb | import path | bare global (curated table) |
| Reach a project symbol | import path | bare global (shim tree) |
| **Find a framework hook (op/event token)** | **the token object** | **name → token registry** |
| Disambiguate a collision | — | `plugin.symbol` namespace |

Hook discovery is **autoload applied to operation/event tokens**. The token's
`name` field is its autoload/registry identifier. One registry, one collision
policy, one namespace form — not two parallel mechanisms.

### 11.2 Why not "autoload the token objects"

Installing the framework's `OperationToken`/`EventToken` objects onto
`globalThis` answers *"how do I type a token"* but **not** *"how does a third
party find a token it was not compiled against"*. It also globalizes the
namespace for a discovery concern and remains curated (a plugin hitting an
undocumented/newer operation is back to importing). Rejected.

### 11.3 Why the name→token registry is the correct primitive

The identity-token design (`defineOperation`/`defineEvent`; see
`src/extensions/interceptors.ts`) is type-safe and refactor-safe — the token
object is the key, so two same-named tokens never collide. Its **one** weakness
is that a third party cannot obtain the token object. The fix generalizes the
precedent already set by `createServiceToken` (`src/extensions/services.ts`):
the token's `name` is currently *"a label for diagnostics, not a key"*. Promote
it to a **registrable alias** — object stays identity internally, `name` becomes
a resolvable key — exactly as services keep identity while gaining a name lookup
layer on top. WordPress ergonomics (hook by name, no import, quiet typos)
becomes WordPress ergonomics **plus** a loud `unknown_operation` at setup.

### 11.4 Design

1. **Promote token `name` to a governed key.** A framework-owned registry
   collects every `defineOperation`/`defineEvent` token under its `name`.
   Identity is unchanged; the name is a lookup alias.
2. **Namespace-govern the names.** Existing names are already mostly namespaced
   (`'blog.post.create'`, `'job.pushed'`, `'request.started'`) — the **one**
   exception is `'logError'` (`src/logging/events.ts:14`), rename to
   `'logging.error'`. Collision policy then applies uniformly: unique name →
   resolvable directly; duplicate → `plugin.name` namespace, bare resolves
   first-in-order (framework subpaths → plugin declaration order → lexical).
3. **`intercept`/`observe` accept `OperationToken | string`.** A string resolves
   through the registry at **registration** (setup time), so a typo fails loudly
   with `unknown_operation` — never silently like WordPress.
4. **One registry, three entry kinds.** The registry carries authoring symbols
   (`FRAMEWORK_GLOBALS`), hook tokens (op/event), and — via the shim tree —
   project symbols. One collision policy; one `plugin.x` namespace form; one
   `.d.ts` emission pass (token *types* emitted so `intercept('job.pushed', fn)`
   is typed).
5. **Autoload follows for free.** A plugin reaches `definePlugin`/`intercept`/
   `observe` bare (autoload) and hooks by name (registry). No token globals are
   required — §11.2 stays rejected.

### 11.5 Third-party declaration surface

`PluginDescription` (`src/extensions/plugin-contract.ts`) documents its own
contract: *"Add fields only as concrete consumers need them — this is not a
generic free-form bag."* The registry is a concrete consumer, so add:

```ts
export interface PluginSymbol {
  readonly name: string;     // bare identifier the plugin author exposes
  readonly specifier: string; // where the consumer resolves it from
}

// on PluginDescription:
readonly symbols?: readonly PluginSymbol[];
```

Third parties declare their authored surface through the existing pure,
build-inert `describe()` seam (same one carrying `components`/`theme`/
`commands`). First-party authored surface is declared in `FRAMEWORK_GLOBALS`
(extended — see §11.7).

### 11.6 Namespace form — the planner's defect, corrected

The draft used a **dotted key** `globalThis['content.readingTime']`, which is a
single property whose name contains a dot — **not** reachable as
`content.readingTime`. Correct form is a **real namespace object**, emitted
**only when a collision exists**:

```js
globalThis.content = { readingTime, blogIndex, ... };
```

```ts
declare const content: {
  readingTime: typeof import('jsails/content').readingTime;
  blogIndex: typeof import('jsails/content').blogIndex;
};
```

**Not** `declare namespace` — it conflicts with a same-named `declare const`.
When no collision exists, install the bare name only and emit no namespace decl.

### 11.7 Category C / D closure

- **Category C** (`jsails/content` read-side helpers used as values in 6–7
  starter-static pages): add `readingTime`, `blogIndex`, `tagIndex`,
  `createMarkdownStaticPaths` to `FRAMEWORK_GLOBALS` (`jsails/content`), then
  strip those value imports from `pages/about.tsx`, `pages/index.tsx`,
  `pages/blog/index.tsx`, `pages/blog/[slug].tsx`, `pages/categories/[term].tsx`,
  `pages/tags/index.tsx`, `pages/tags/[term].tsx`.
- **Category D**: drop `import { site } from '../shared/site.js'` at
  `templates/starter-static/ui/layout.tsx:40` — `site` autoloads via the shim
  tree (`shared/site.ts` is its sole provider).
- **Category A/B stay imports**: `zod`, `preact` types, and all `import type`
  lines are untouched.

### 11.8 Four touchpoints that must all agree

1. **Registry build** — derive from declared surfaces (`FRAMEWORK_GLOBALS`
   extended + `PluginDescription.symbols`) and the token registry; compute
   collisions; assign namespaces.
2. **Runtime install** — `src/internal/framework-globals-install.ts` installs
   bare names and, on collision, the real namespace object.
3. **Ambient `.d.ts` emission** — `generate-imports-dts.ts` +
   `jsails-global-dts.ts` emit split value/type pairs and namespace decls.
4. **Consumer resolution** — replace the hard errors in
   `src/compiler/autoload-scan.ts` (`duplicate_symbol`) and
   `src/compiler/autoload-shims.ts` (`ambiguous_symbol`) with order-resolution:
   first-in-order wins bare, `pluginName.symbol` always resolves.

### 11.9 Waves (implementation order)

- **W1** `src/extensions/interceptors.ts` — name→token registry; name-governed
  names; `intercept`/`observe` accept `OperationToken | string`; resolve at
  registration with `unknown_operation` on miss.
- **W2** `src/logging/events.ts:14` — rename `'logError'` → `'logging.error'`
  (update `src/logging/index.ts` consumers and tests).
- **W3** `src/extensions/plugin-contract.ts` + `src/compiler/declarative-plugin.ts`
  — `PluginSymbol`, `PluginDescription.symbols`; export from
  `src/extensions/index.ts`.
- **W4** `src/internal/framework-globals.ts` — add Category C helpers.
- **W5** registry build + `src/internal/framework-globals-install.ts` — merged
  table (framework + plugin symbols + tokens); namespace-object install.
- **W6** `src/compiler/jsails-global-dts.ts` + `generate-imports-dts.ts` —
  plugin symbols, token types, namespace decls, context split.
- **W7** `src/compiler/autoload-scan.ts` + `autoload-shims.ts` — replace hard
  errors with order-resolution.
- **W8** `src/compiler/autoload-plugin.ts` + `src/build/generate-meta.ts` —
  carry the merged index into `.jsails/autoload.json`; inject `'app'`-context
  only.
- **W9** starter-static Category C/D edits (§11.7).
- **W10** full quartet.

### 11.10 Semver-visible API note

Promoting `name` to a key makes token names a **semver-visible API**: a plugin
hooking `'job.completed'` couples to that string. This is intentional — names
are governed (namespaced, documented, checked at registration), exactly as
WordPress's strings are its API but *unchecked*. Renaming any token name in
future is a breaking change to hook registration compatibility.

### 11.11 Verification

- Token registry: name resolves to the same identity as the exported token;
  unknown string → `unknown_operation`; collision → namespaced + bare
  first-in-order (`test/extensions/interceptors.test.ts`).
- Namespace form: `globalThis.content.readingTime` is reachable; bare
  `readingTime` is too; no `declare namespace`/`declare const` conflict
  (`test/compiler/jsails-global-dts.test.ts`).
- Category C/D: starter-static pages carry no `jsails/content` value imports and
  no `site` import (`test/app/starter.test.ts`).
- Quartet baseline: `npm run check` = **6408 tests / 6407 pass / 0 fail / 1
  skipped**. Invariant = **0 fail**.

## 12. The autoload surface — Option A (catalog complete, projection governed)

> **SUPERSEDED by §13.** Option A's *governed projection* (a curated eligible set,
> warnings-as-suppression) was rejected in favour of Option B2-target-split:
> project **every** value export, split by runtime target, with overrides
> **warned, never suppressed**. §12 is kept for the measurement history that
> fed §13; the authoritative spec is §13.2–13.8.

### 12.1 The decision

`FRAMEWORK_GLOBALS` (the frozen 24-name table) is **replaced by a derived
catalog plus a projection rule**. The premise (user-confirmed): *everything is
autoloaded* means **complete reach + complete types**, while the host global
stays **clean** — a governed projection, not a wholesale dump.

Three layers, deliberately separate:

| Layer | Contents | Constraint |
| --- | --- | --- |
| **Catalog** (registry) | every autoloadable value symbol, keyed by (provider, name) | none — complete, derived |
| **Types** (ambient `.d.ts`) | every catalog symbol, bare-name `declare const X: typeof import('spec').X` | none — erased at runtime |
| **Projection** (`globalThis`) | rule-approved names only | governed (see 12.3) |

### 12.2 Eligibility — 31 authoring subpaths

Derived from the per-subpath classification (verified against barrels).

**Eligible (31):** `admin, api, app, auth, blog, broadcast, cache, content,
database, diagnostics, encryption, extensions, filesystem, flags, http, i18n,
inertia, jobs, logging, mail, models, notifications, pages, plugin-tools,
routing, seo, server-components, sessions, signals, theme, validation`.

**Ineligible (13) — never feed the catalog:**

- browser-safe: `broadcast/client, client, client/model, jsx-runtime`
- build/CLI/test: `admin-plugin-manager, build, deploy, globals, introspect,
  jamal, plugins, render-to-string, testing`

(`render-to-string` is a single server-SSR utility, not authoring vocabulary.)

### 12.3 The projection rule (`globalThis`)

Install a catalog name **iff** it passes all three:

1. **Not a host collision.** Reject names on the frozen host-global denylist.
   Measured collision: exactly `require`. Denylist is explicit + testable.
2. **Not an error class.** `name.endsWith('Error')` → catalog + types, not
   projected. (Exception: signal/event tokens such as `logError` are renamed in
   W2 — see 12.6.)
3. **Authoring vocabulary, not a composition root.** Project names an app author
   writes **in application code** (models/jobs/pages/components/resources), not
   names used **in framework configuration** (adapters/transports/stores/disks).
   Positive matchers: `define*`, relation decorators, query builders (`F`/`Q`/
   `q*`), base classes (`ApplicationRecord`/`BaseEntity`), hook factories
   (`counterCache`/`touch`/`autosave`/`nestedAttributes`/`encrypts`/`delegate`),
   and `*Plugin` factories.

Rule 3 is **irreducibly a curation**, but a *category-based* one (application
vocabulary vs configuration/adapters), not an ad-hoc list. The audited table in
12.4 *is* that curation.

### 12.4 Measured buckets (from built `dist`, 31 eligible barrels)

`node /tmp/autoload-bucket.mjs` (read-only, static export enumeration):

- catalog slots **641**, distinct names **607**
- **PROJECT** (bare global) **169** — before rule-3 refinement (see 12.5)
- **CATALOG_ONLY** (type-only) **438** — 351 not-authoring-vocab, 86 error-class, 1 host-collision (`require`)
- **COLLISIONS** (provider-vs-provider) **16**

Flagged defects the measurement exposed (fixed in 12.5):

- **`default` is the top collision (20 providers).** `export { <X>Plugin as
  default }` — a re-export alias, never a writer's bare name → **dropped from the
  catalog entirely**, not a collision.
- **PROJECT leaks composition roots**: `createBullMQAdapter`,
  `createSmtpTransport`, `createValkeyCacheStore`, `createValkeyMutexStore`,
  `createSocketIOBroadcastAdapter`, `createLocalDisk`,
  `createDatabaseBlogStore`… — `create*` alone is not authoring vocabulary.
- **Eager heavy deps reachable from eligible barrels**: `jobs→bullmq`,
  `broadcast→socket.io`, `auth→better-auth`, `app/pages→unhead`/`sitemap`,
  `admin→preact-render-to-string`. ⇒ the **catalog is enumerated statically**
  (read export names from the barrel), never by eager-importing barrels; only
  **projected** names have their modules loaded.

### 12.5 Confirmed projection rule (post-measurement)

`PROJECT` = catalog name that is (a) not `default`, (b) not on the host denylist,
(c) not `endsWith('Error')`, and (d) matches application-authoring vocabulary
**and** is not on the **composition-root exclusion set**:

```
createBullMQAdapter, createSmtpTransport, createCallbackTransport, createMemoryTransport,
createValkeyCacheStore, createValkeyMutexStore, createMemoryCacheStore, createMemoryMutexStore,
createSocketIOBroadcastAdapter, createLocalDisk, createMemoryDisk, createVariantResolver,
createDatabaseBlogStore, createDatabaseFeatureFlagStore, createDatabaseSessionStore,
createJobsRuntime, createServerComponentsRuntime, createResourceRouter, createResourceHandlers,
createApp, createHttpServer, createPublicFilesMiddleware, createAuth, createApiToken*,
createBatchCoordinator, createSharedBatchCoordinator, createJobBatch, createJobChain,
createBatchMiddleware, createOverlapMiddleware, createPermissionRegistry, createMiddlewareRegistry,
createInterceptorRegistry, createServiceRegistry, createServiceToken, createContractToken,
createComponentSigner, createDownloadReferenceSigner, createUrlSigner, createFederated..., ...
```

Exact set finalized when the rule is coded; the *principle* is fixed (composition
roots excluded). A name is either application vocabulary or a composition root —
the audit table records which, per name.

### 12.6 Interaction with W2

`src/logging/events.ts` currently exports a token literally named `logError`,
which rule 2 mis-classifies as an error class. W2 renames it `'logging.error'`;
the exported constant renames accordingly, removing the false positive.

### 12.7 Mechanism (unchanged primitives, now load-bearing)

- `computeCollisionGroups` / `deriveNamespaceKeys` (single definition in
  `src/internal/framework-globals.ts`) now operate over the **derived catalog**,
  so the collision machinery — currently dead (empty on the curated 24) —
  becomes load-bearing (16 provider collisions).
- Ambient emitter (`jsails-global-dts.ts`) emits **all catalog names** (unbounded,
  erased — type-only for unprojected names verified in this session: bare
  `defineJob` type-checks with no import; wrong args → TS2322; `globalThis.
  defineJob` stays `undefined` until projected; `require` type-checks ambiently
  and the host global is untouched).
- Installer: catalog → apply rule → project; **report** non-projected names
  (never silent).

### 12.8 Verification additions

- Catalog is derived (not hand-listed): no `FRAMEWORK_GLOBALS` literal remains.
- Projected set has **zero** host collisions (assert `require` etc. absent).
- The 16 provider collisions install winner-bare + namespaced object.
- Ambient `.d.ts` covers all 607 distinct names; type-only names need no import.
- Install does **not** eagerly import `bullmq`/`socket.io`/`better-auth` for
  names that are catalog-only.
- Quartet baseline unchanged invariant: **0 fail**.

## 13. Option B (chosen) — everything, target-split, warn on override

### 13.1 The decision (supersedes §12's projection-governance)

**B2-target-split.** Project **every** value export of **all 44 subpaths** onto
`globalThis` — split by runtime target, because the package spans two runtimes
and therefore has two globals. "Everything" means everything *reachable in the
runtime you are actually in*. When a projection **overrides something
important**, emit a **warning naming the cause and the origin** — never throw,
never silently suppress.

Rejected: **B1** (authoring subset) and **§12's governed projection** — both were
the "easy" subset. **B2-flat** (every name onto every global) was rejected as
broken: it installs browser runtime into the server process and the compiler
graph into the browser bundle.

### 13.2 Target classification (measured from built barrels, static reach)

Static (eager) reachability traced transitively through `import`/`export … from`;
`import type` and dynamic `import()` are **not** eager and do not affect the
target. Two host-label corrections from measurement:

- `mail`/`notifications` reach nodemailer only via **lazy** `import()` ⇒
  browser-clean.
- `broadcast/client` static-imports `socket.io-client` (a **browser** lib), not
  the server `socket.io` ⇒ browser, not server.

**`browser` (in the client bundle):** `client`, `client/model`, `broadcast/client`,
`jsx-runtime`, `render-to-string`.

**`both` (browser-clean barrel, also usable server-side):** `api`, `blog`,
`cache`, `extensions`, `flags`, `http`, `i18n`, `logging`, `signals`, `mail`,
`notifications`, `sessions`, `theme`, `validation`.

**`server` (eagerly reaches `node:*` or a server-only lib):** `admin`,
`admin-plugin-manager`, `app`, `auth`, `broadcast`, `build`, `content`, `database`,
`deploy`, `diagnostics`, `encryption`, `filesystem`, `globals`, `inertia`,
`introspect`, `jamal`, `jobs`, `models`, `pages`, `plugin-tools`, `plugins`,
`routing`, `seo`, `server-components`, `testing`.

Counts: browser 5, both 14, server 25 (total 44).

**Correction (B-W1a, measured).** The three-way split collapses to **two**
targets for projection: an unstable `both` adds nothing, because every non-server
subpath rides the **browser** catalog regardless of whether it is also
server-usable. The scanner (`src/compiler/framework-catalog-scan.ts`) therefore
emits only `server | both`, and:
- **server catalog** = exports of all subpaths the scanner does not exclude,
- **browser catalog** = exports of the non-server subpaths,
- `jsails/jsx-runtime` contributes **0** names (its only export is
  `export * from 'preact/jsx-runtime'`, an external star that is skipped by
  design — those are Preact's names, not the framework's).

**Correction (B-W5, measured).** The denylist classifier was replaced by a
fail-safe allowlist, so the pre-B-W5 lists above are stale: with the corrected
classifier `blog`, `flags`, and `sessions` are **server** (their barrels reach
`typeorm`), not `both`. `server` becomes **28** and non-server (browser) becomes
**15**: `api`, `broadcast/client`, `cache`, `client`, `client/model`,
`extensions`, `http`, `i18n`, `logging`, `mail`, `notifications`,
`render-to-string`, `signals`, `theme`, `validation`. Additionally
`jsails/globals`/`jsails/globals/client` (the projection's own machinery) are
excluded from **both** catalogs.

Measured: **832 value exports / 816 distinct names / 16 name collisions**, `default`
absent. The scanner classifies target by a transitive walk of the **eager**
import graph: `import type` must not count — a two-line miss (`importKind` is not
`exportKind`) silently marks `api` (→ `contracts/http.ts` → `routing/routes.ts`)
server. That is the load-bearing correctness point of the walk.

### 13.3 Two catalogs

- **Server catalog** = value exports of every non-excluded subpath (a Node process
  can load every barrel; nothing is browser-restricted) → projected onto the
  **server** `globalThis`. Post-B-W5: **824** entries across 42 subpaths.
- **Browser catalog** = value exports of the **15 non-server subpaths** →
  projected onto the **browser** `globalThis` (inside the client bundle).

The browser catalog **excludes** every `server` subpath: their barrels are not
node-free, so projecting them would pull `node:*`/Better Auth/TypeORM/the
compiler into the browser bundle. This is the load-bearing reason for the split.
The fail-safe allowlist over-classifies (a specifier not known browser-safe is
`server`) so the failure mode is a symbol reachable only by explicit import —
never a leaked server dependency in the client graph.

### 13.4 Warning model (user directive)

A projection warns when the value **changes** an existing `globalThis` property
of a different origin. Idempotent re-install of an identical value is silent.
Never throws. Message names **cause + origin**:

```
[jsails] globalThis.require is being overridden
  from:   jsails (framework, jsails/api)     ← origin of the NEW value
  over:   node host global                    ← what is lost
  reason: host global collision
```

Origin kinds: `framework subpath`, `plugin <name>`, `pre-existing (unknown)`.
The origin is *how the author learns it is their code or an installed plugin*.

Overrides that warn: (1) host global (`require`, `process`, …); (2) framework
provider-vs-provider collision (`has_many` models vs database) — loser still
reachable via namespace object; (3) a name already owned by another
plugin/pre-existing global.

### 13.5 Preserved from §12

- Catalog **statically enumerated** (read export names), never eager-imported to
  build; only **projected** names load their module.
- Ambient `.d.ts` covers **all** catalog names (browser + server), type-only
  names need no import — proven in this session (TS2322 on misuse, zero runtime
  effect, `require` ambiently type-clean, host untouched).
- `default` dropped from catalog (re-export alias, 20 barrels).
- Collision machinery (`computeCollisionGroups`/`deriveNamespaceKeys`) becomes
  load-bearing.
- Missing declared symbol still **throws** (stale catalog = framework bug).

### 13.6 New runtime code

The **browser projection is new**: the client bundle must run an install step
(no such step exists today — browser entry is `registerIsland`+`startClient`).
This is the accepted cost of "everything bare in the browser too". The server
projection already exists at CLI bootstrap (`src/cli/index.ts:405`).

### 13.7 Verification additions (supersedes §12.8 projection checks)

- Two catalogs derived (browser ⊂ eligible-clean; server = all).
- Browser catalog contains **no** `server`-subpath name; asserted by subpath
  provenance.
- Projecting the browser catalog in a node context pulls **no** `node:*`.
- Override warnings fire **once per changed value** with origin; identical
  re-install silent.
- `require` override **warns and proceeds** (B semantics) — host global
  reachable-by-convention otherwise.
- Quartet baseline invariant unchanged: **0 fail**.

### 13.8 Waves (implementation order)

Each wave is independently verifiable and leaves the quartet green (invariant
**0 fail**). Ordering: catalog first (pure data), then the warn semantics
(runtime, testable with an injected table), then the ambient emitter (types),
then the new browser projection last (new surface, isolated).

**B-W1 — Catalog derivation (pure, replaces the literal). — DONE**

*Implemented shape (differs from the first sketch; back-compat dropped per the
"do it right" directive).* The derivation is split into **mechanism** and
**data**, and the data is a **committed generated module** guarded by a
self-contained data-compare test (chosen over a `git diff --exit-code` gate):

- **Mechanism** — `src/internal/framework-globals.ts`: defines
  `FrameworkGlobalTarget = 'server' | 'both'` (binary; the three-way split is
  superseded per §13.2) and `FrameworkGlobal { name; specifier; target }`;
  re-exports `FRAMEWORK_CATALOG`/`BROWSER_CATALOG` from the generated module;
  keeps `frameworkGlobalSpecifiers()`, `computeCollisionGroups`,
  `deriveNamespaceKeys`. The curated 24-name `FRAMEWORK_GLOBALS` literal is
  **removed outright** (no alias).
- **Scanner** — `src/compiler/framework-catalog-scan.ts`: static export
  enumerator (`parseSync` from `rolldown/utils`), binary target classifier over
  the 44 subpaths. `FrameworkGlobalTarget` is imported **type-only** from
  `../internal/framework-globals.js` (single definition). Two AST bugs fixed:
  imports use declaration-level `importKind`, and the `exportKind === 'type'`
  guard runs **before** the inline declaration name is recorded (removed 5
  phantom value leaks, 832 → 827).
- **Generator** — `scripts/generate-framework-catalog.mjs`: runs the compiled
  scanner, sorts by name then specifier, writes the committed data module.
  Invoked by `scripts/build.mjs` (there is no separate command — see §13.8).
- **Data** — `src/internal/framework-catalog.generated.ts`: committed module; the
  `default` export is **absent**; `skippedStars` records the one external
  `export *` (`jsails/jsx-runtime` → `preact/jsx-runtime`).

Measured: **827 value exports / 16 collisions**; server = all 44 subpaths;
browser = the 18 non-server subpaths (`BROWSER_CATALOG` =
`FRAMEWORK_CATALOG.filter(e => e.target !== 'server')`). Two measurement-driven
corrections: `mail`/`notifications` reach nodemailer only lazily ⇒ `both`;
`broadcast/client` statically imports `socket.io-client` (a browser lib) ⇒ `both`.

Why a committed file + test rather than emitting into `dist/` post-`tsc`: a
post-`tsc` catalog forces every consumer to **dynamic-import** it and breaks the
synchronous, pure `generateJsailsGlobalDts` emitter — a strictly worse design.
The catalog is a pure function of the framework's `src/` barrels, so it is
statically importable and belongs in `src/`. Drift is caught by the test, not by
`git` state.

Verify (done): `test/internal/framework-globals.test.ts` (catalog floor >700;
no `default`; unique `(name, specifier)`; real collisions exist + `ApplicationRecord`
present; browser = non-server filter; specifiers sorted; every name really
exported), `test/compiler/framework-catalog.test.ts` (drift guard —
data-compare, formatting-immune), `test/compiler/jsails-global-dts.test.ts`.
Full quartet green: **check 6475 / 6474 / 0 fail / 1 skip** (baseline 6471 + 4
new tests); `verify:starter --skip-browser` 0 fail / 8 skip / 0 browsers;
website check 16 pages OK.

**B-W2 — Warn-on-override installer. — DONE**

`src/internal/framework-globals-install.ts`: the blind collision-only assignment
is replaced by a `projectBare(name, value, origin, notOverridable?)` closure.
Public surface: `GlobalOrigin = \`framework:${specifier}\` | \`plugin:${name}\` |
\`namespace:${key}\` | 'pre-existing (unknown)'`; `GlobalOverrideWarning { name,
from, over, reason: 'override' }`; `InstallFrameworkGlobalsOptions.onWarn?`
(default `console.warn`) and `origin?` (labels a whole table, for plugin
projections). Re-exported (types) from `jsails/globals`.

Rules implemented:
- Identical value re-install ⇒ **silent** (value-identity compare).
- Changed value over an occupied slot ⇒ `onWarn({ name, from, over, reason })`
  then **assign** — never throws, never suppresses.
- Origin provenance is a module-level `Map<string, GlobalOrigin>` persisted
  across calls (globalThis carries none): a slot occupied but unrecorded is
  `pre-existing (unknown)`.
- **Missing declared symbol still throws** a value-free error (framework bug) —
  override handling never masks it.
- **Collision bare-slot disambiguation.** The old `if (!(name in target))` check
  conflated "first-in-order already won" with "a pre-existing global owns the
  slot"; a per-call `assignedBare` set separates them, so a colliding name's
  first-in-order entry *does* override a pre-existing global (with a warning)
  while later colliding entries never touch the bare slot.
- **Namespace identity is stable.** Namespace objects project with
  `notOverridable = true`, so an idempotent re-install keeps the prior object
  (identity preserved) instead of warning on every call.

Verify (done): `test/internal/framework-globals.test.ts` — +6 cases (silent-empty,
silent-idempotent, warn-once-then-proceed, foreign-value override, plugin-origin
label, missing-symbol-still-throws) plus a colliding-override case; real-catalog
tests pass a no-op `onWarn`. Full quartet green: **check 6482 / 6481 / 0 fail /
1 skip**; `verify:starter --skip-browser` 0 fail; `build` + website 16 pages OK.

Note: measured on the real catalog in an ESM process, **no bare override
actually fires** (`require` is undefined in ESM), so the default `console.warn`
stays quiet on a clean boot.

**B-W3 — Two-target ambient emitter. — DONE (decision: union only, no
`target` option)**

The emitter already emits **all** catalog names (both targets) and derives its
collision namespace decls from `computeCollisionGroups` over the same derived
catalog — so no production change was needed for the default. The one candidate
change from the original sketch — an optional `target` option to scope the
emitted set — was **rejected as dead code**:

- `.jsails/jsails-global.d.ts` is a **single** file included by *both*
  `tsconfig.json` (server) and `tsconfig.client.json` (browser). Server-only
  scoping breaks server typechecks; browser-only scoping breaks server
  typechecks. The union is the only value that typechecks both, and it is what
  the emitter already defaults to (`FRAMEWORK_CATALOG`).
- No caller can pass a target: there is exactly one d.ts file per project, so a
  `target` option would never be invoked.

Per-target strictness was also considered (a second `jsails-global.client.d.ts`
declaring only `BROWSER_CATALOG`, included by `tsconfig.client.json`) and
rejected: the starter's island/UI code references **zero** bare framework globals
(verified — `templates/starter/client/main.tsx`, `ui/layout.tsx`,
`ui/components.tsx`, `ui/counter.tsx` use explicit imports only; `layout.tsx`
imports `RequestContext` as a type), so the "browser file uses a server-only
global" hazard no real code path hits. The union is a **superset**: a browser file
referencing a server name gets an ordinary `ReferenceError`, exactly like any
missing global, and the drift test already guarantees the d.ts never
*under*-declares. Doubling the ambient surface for an unreached hazard is not the
"do it right" trade.

Hardening added: `test/build/generate-meta.test.ts` gains a guard proving the
artifact a **real build** writes (`buildMetaArtifacts`) declares every distinct
catalog name across both targets — closing the gap between the pure emitter test
and the threaded result (if the catalog were ever narrowed to `BROWSER_CATALOG`,
server authoring would silently stop compiling). Verify (done): emitter + meta
tests green (10 + 11).

**B-W4 — Server projection wiring (CLI). — DONE (verified, no code change)**

Both server install call sites already project the **full** `FRAMEWORK_CATALOG`:
`src/cli/index.ts:405` (`installGlobals` → `await installFrameworkGlobals()` with
no args) and the generated `.jsails/globals.js` (`autoload-shims.ts:406-408`,
same no-arg call). `installFrameworkGlobals` defaults `globals` to
`FRAMEWORK_CATALOG` (`framework-globals-install.ts:171`), so the full union —
including server-only names — is projected before any app module, config, or shim
is imported. The plan's `SERVER_CATALOG` name was the pre-B-W1 sketch; the
implemented shape uses the single `FRAMEWORK_CATALOG` (server install = all
entries), which is equivalent for the server target and needs no second constant.

Coverage (already present, non-duplicative — no new test added):
- all catalog names land on `globalThis` → `test/internal/framework-globals.test.ts`
  (`assigns every framework global onto globalThis`).
- generated `globals.js` calls `installFrameworkGlobals()` → byte-exact assertion
  in `test/compiler/autoload-shims.test.ts:211`.
- **ordering invariant** (framework install before any shim import) →
  `autoload-shims.test.ts:172-176`.
- d.ts declares the full union → B-W3 `generate-meta` guard.

An end-to-end run of the shim/e2e/catalog suites (27/27) confirms the server path.
Verify (done): no regression; quartet unaffected (no production change).

**B-W5 — Browser projection (NEW runtime surface).** — **DONE.**

**Classifier fix (prerequisite).** The scanner's `SERVER_ONLY_DEPENDENCIES`
denylist was incomplete: `jsails/blog` (barrel re-exports `./database-store.js`,
which statically imports `typeorm`), `jsails/flags`, and `jsails/sessions` were
wrongly classified `both`, so a client bundle would have tried to bundle
TypeORM. Replaced with a fail-safe **`BROWSER_SAFE_DEPENDENCIES` allowlist** in
`framework-catalog-scan.ts` (`preact`, `preact/hooks`, `preact/jsx-runtime`,
`preact-render-to-string`, `@preact/signals`, `@preact/signals-core`,
`@hotwired/turbo`, `socket.io-client`, `zod`, `hono`): a bare specifier not on
the allowlist, and every `node:*` builtin, forces `server`. `blog`/`flags`/
`sessions` now classify `server`; `BROWSER_CATALOG` is **15** subpaths.
Fail-safe in the right direction: a missing allowlist entry over-classifies to
`server` (name importable explicitly, just not projected) rather than leaking a
server dep into the client graph.

**Self-projection exclusion.** The projection's own machinery must not be
projected: `installFrameworkGlobals` as a bare global is meaningless, and the
browser installer importing `jsails/globals/client` would be a self-cycle.
`scanFrameworkCatalog` now skips `PROJECTION_INFRASTRUCTURE_SPECIFIERS`
(`jsails/globals`, `jsails/globals/client`), so `FRAMEWORK_CATALOG` is **824**
value exports (was 827 before the exclusion) and both catalogs are
self-consistent.

**Engine extraction (mechanism vs. environment).** `installFrameworkGlobals`
was server-only (top-level `node:fs`/`node:path`/`node:url` + the
`installProjectGlobals` file I/O). The **pure projection engine** — origin
types, the shared `installedOrigins` provenance map, `projectBare`, collision/
namespace derivation, the missing-symbol throw — moved to node-free
`src/internal/framework-globals-project.ts` as `projectGlobals({ globals,
modules, onWarn?, origin? })`. The server installer became a thin loader (load
modules via dynamic `import(specifier)`, then call `projectGlobals`); it
re-exports `GlobalOrigin`/`GlobalOverrideWarning` so the `jsails/globals` barrel
is unchanged. One engine ⇒ the server and browser projections cannot diverge on
collision/warning semantics.

**Browser installer.** `src/internal/framework-globals-install-browser.ts`:
`installBrowserGlobals({ onWarn?, origin? })` loads each of the 15 browser
subpaths via a **literal import thunk map** (Vite/Rollup can only follow a
statically-analyzable dynamic import; a variable specifier produces a runtime
resolution the bundler ships nothing for) and calls the shared `projectGlobals`
over `BROWSER_CATALOG`. A missing loader is a build-wiring bug and throws
loudly. `browserGlobalSpecifiers()` exposes the sorted list for tests.

**New subpath.** `jsails/globals/client` (`src/globals/client.ts`) is the
browser preload entry, symmetric with `jsails/globals`. It is a **separate
subpath**, not a re-export from `jsails/client`: the installer imports the
browser barrels (`jsails/api`, `jsails/theme`, …), so re-exporting from the
client barrel would make `jsails/client` import a module that imports
`jsails/client`. Exporting it here keeps the client barrel installer-free.

**Deliberate non-goal — no auto-wiring into `startClient`.** The wave sketch
suggested wiring the install into `startClient`; that reintroduces the cycle
above (`navigation.js → installer → client/index.js → navigation.js`). The
browser install is an **explicit** call from the app's client entry, mirroring
the server's explicit `installGlobals(configPath)` call in the CLI. An app's
`client/main.tsx` calls `await installBrowserGlobals()` before hydration.

Verify (done): `test/client/framework-globals-browser.test.ts` (4 tests) —
browser catalog excludes every server subpath (`database`/`blog`/`flags`/
`sessions`/`admin`/`jobs`/`server-components`); `browserGlobalSpecifiers()`
equals the distinct catalog specifiers; every specifier has a literal loader
(install succeeds and every projected name lands on `globalThis`); idempotent
re-install emits no override warnings. `framework-catalog` drift + scanner +
`framework-globals` (30) all green after regeneration (824 exports, 15 browser
subpaths).

**Generator stability fix (found in B-W7).** `scripts/generate-framework-catalog.mjs`
emitted the raw literal with `JSON.stringify` — double-quoted, one line per entry
— which Prettier immediately rewrote to the repo's single-quote/print-width
style. So the generator always produced a file that failed `format:check`,
and regeneration oscillated against `format`. The generator now runs Prettier
(`resolveConfig` + `format`) on its own output, so generation is
idempotent and formatting-stable and `format:check` passes on the freshly
generated file. Verified: two consecutive runs produce a byte-identical file;
`prettier --check` clean.

**B-W6 — Remove literal remnants + doc sweep. DONE.**
The curated `FRAMEWORK_GLOBALS` literal was already **removed in B-W1** (no alias
was ever introduced), and no `FRAMEWORK_GLOBALS` reference remains in
`src`/`docs`/`website`/`scripts`/`test` (only historical prose in this plan).
Docs updated:
- `website/content/docs/conventions.md` — new "Two projections: server and
  browser" subsection documenting `jsails/globals` (`installFrameworkGlobals`,
  full catalog) and `jsails/globals/client` (`installBrowserGlobals`, browser-safe
  catalog only), the shared collision/override engine, and why a third-party name
  can never be shadowed.
- `website/content/docs/getting-started.md:138` — corrected the now-false
  "JSails uses scaffolding instead of autoloading" to describe the generated
  autoload layer.
- `docs/CODEMAP.md` — added both `./globals` and `./globals/client` to the
  subpath table (the table previously omitted `./globals` entirely).
Plan §12 marked superseded by §13 (see note at its head). Verified: no
`FRAMEWORK_GLOBALS` references remain; `website run check` OK (16 pages).

**B-W7 — Full quartet. DONE.**
`npm run format` (clean) → `build:clean` (exit 0) → `check`
(**6487 tests / 6486 pass / 0 fail / 1 skip** — exactly the predicted
baseline; invariant **0 fail** holds) → `verify:starter --skip-browser`
(**0 failed**, 8 skipped as expected, 0 browsers) → `build` (exit 0) +
`website check` (16 doc pages OK). All five stages green.

**Catalog generation = an honest two-phase build (B-W7 follow-up). DONE.**
Question raised: should `generate:catalog` be folded into `build`/eliminated?
Answer: **no** — the fold-in was wrong, and the reasoning survives scrutiny.

The catalog cannot be removed: a deployed app ships only `dist/`, and `tsc` needs
the export names statically for the ambient `.d.ts`, so the catalog must be a
committed source module; a runtime scan cannot serve the shipped path.

There is a **true cycle**, confirmed empirically, not assumed: the catalog is an
**input** to `tsc` (three compiled `src/` modules import it, plus the d.ts
emitter), while the scanner that derives it lives in `src/` and is an **output**
of `tsc`. That cycle is structural. Every attempt to avoid the second compile was
tested and rejected:
- *Run the scanner from TS source via Node type-stripping* — works on Node 22+
  but the repo supports Node 20 (CI matrix `20.19.0/22.13.0/26.x`), which has no
  type stripping. Non-portable.
- *Compile the scanner as its own tiny `tsc` project first* — feasible but fights
  the repo's incremental build config and adds a second tsconfig + out-of-tree
  build dir + a generate step that must stay in lockstep with the main project
  for **no** net reduction in moving parts.

So the two-pass quiet is **textbook** for checked-in generated source
(cf. Protobuf/GraphQL/Prisma codegen) — it is the correct DAG, not a hack. The
genuine defects were naming/ownership, now fixed:
- `scripts/generate-framework-catalog.mjs` is the **sole owner** of the operation
  and is **self-contained**: it compiles the scanner (`tsc -p tsconfig.json`) and
  then scans, so it can **never** run against a stale `dist/` scanner — the exact
  foot-gun that motivated deleting the command. Idempotent (`unchanged`/exit 0,
  `wrote`/exit 2).
- `generate:catalog` is restored as the canonical standalone command
  (`node scripts/generate-framework-catalog.mjs`).
- `scripts/build.mjs` **calls `generate:catalog`** (does not inline the scan),
  then compiles `src/`; it runs a **second `tsc` only when the catalog was
  rewritten** (so `dist/` is never one revision behind `src/`). On a stable tree
  this is a ~2.4s no-op with a single compile.
- The drift test (`test/compiler/framework-catalog.test.ts`) stays — it is the
  belt-and-braces guard for anyone who edits a barrel and runs only `tsc`.
- `build:watch`/`pretest:watch`/`typecheck` still call `tsc` directly (watch mode
  must not regenerate per keystroke; a bare typecheck needs no generation).

Verified: `generate:catalog` standalone compiles-then-scans (2nd run `unchanged`
/ exit 0); `build` on a stable tree is `unchanged`/exit 0/one compile; a synthetic
barrel export makes `build` report `wrote`/825 and run the second compile; revert
returns to `unchanged`/824.

**Scanner bug fix (found while probing the build path). DONE.**
`inlineDeclarationName` in `framework-catalog-scan.ts` read only
`declaration.id`, which exists for `export function f`/`export class C` but **not**
for `export const x`/`let`/`var` — those wrap the name in
`declaration.declarations[0].id`. So an **inline** `export const` in a barrel was
silently dropped from the catalog. Real barrels overwhelmingly use named
re-exports (`export { x } from './y.js'`), which were unaffected, so the
committed catalog was correct in practice and the drift test agreed with itself;
the hole only bit an inline `export const` barrel. Fixed to read through
`declarations[0].id`; the probe that exposed it (a synthetic inline export) now
lands in the catalog as expected. No baseline change: still 824 exports (the fix
added no real name), `check` 6487/6486/0/1.

### 13.9 Wave ordering risks

- **B-W1 is the load-bearing wave.** If the catalog can't be statically derived
  (a barrel exports a value computed at runtime, not a static name), the whole
  design falls back to eager-import enumeration. Verified feasible this session
  (export-name enumeration from built barrels already works: 641 slots/607
  distinct).
- **B-W2 must not break idempotency.** The `await import()` module cache makes
  re-install cheap; the warn-once guard keys on *value identity change*, not call
  count.
- **B-W5 is genuinely new surface.** It is isolated last so the server-side
  quartet is already green when it lands; a browser-projection bug cannot regress
  the server path.
