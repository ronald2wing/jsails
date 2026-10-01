# JSails Model Authoring — Implicit, Compiler-Derived Models

**Status:** approved design · not yet implemented
**Date:** 2026-10-13
**Directive:** do it right, not easy · as easy as possible · implicit but customizable · no backward-compat constraints
**Axiom:** JSails is the framework; TypeORM is an implementation detail. The user writes JSails, never TypeORM.

## 1. The problem being solved

A JSails model today is **three disconnected declarations**:

1. TypeORM decorators for structure (`@Entity`, `@Column`, `@ManyToOne`, `@JoinColumn`),
2. standalone factory calls returning an array (`belongs_to(Post, 'author')`),
3. a manual `createEntitySubscriber(...)` passed to the data source.

The user's model file **imports TypeORM directly** (`src/models/index.ts:11` doc-block:
`import { Entity, Column, ... } from 'jsails/models'` — the canonical example every
user copies, and shipped by `make:model`). TypeORM has leaked into the public API.

**Root cause:** JSails never decided what a model *is*. The docs being wrong (the D5
defect fixed this session) was a symptom, not a typo — a framework whose public
surface *is* its API cannot have canonical examples describing a shape it doesn't own.

## 2. The target

A model is a **class that declares only the shape of its data**. Everything else is
derived. TypeORM decorators never appear in user code.

### 2.1 Implicit (the 90%)

```ts
// models/post.ts — the entire model
export class Post extends ApplicationRecord {
  declare title: string;
  declare published: boolean;
  declare author: Author;        // -> many-to-one; column author_id -> author table
  declare comments: Comment[];   // -> one-to-many (inverse)
}
```

No imports from TypeORM. No `createEntitySubscriber`. No TypeORM decorators. Columns,
foreign keys, junction tables, and migrations are **derived by the compiler** from the
class shape. (Customization, when needed, uses **JSails-owned decorators** — see §2.2 —
never TypeORM's.)

### 2.2 Customizable (the 10%)

Inference cannot know behaviour (`touch`, `counter_cache`, `encrypts`) or intent
(`maxLength`, `nullable`, `unique`, explicit FK column name). Customization is
**inline decorators on the field** — one mechanism, one location, nothing repeated in
a second block:

```ts
export class Post extends ApplicationRecord {
  @jsails.maxLength(200)
  @jsails.unique()
  declare title: string;

  @jsails.encrypts()
  declare body: string;

  @jsails.belongsTo(Author, { touch: true })
  declare author: Author;

  @jsails.hasMany(Comment, { counter_cache: true })
  declare comments: Comment[];
}
```

**The rule (hybrid):** implicit when there is nothing to customize; an explicit
decorator *only* on the field being customized. A model with no special rules is pure
`declare` lines. There is **no companion block** — column constraints and relation
behaviour both live on the field.

**A relation decorator, once written, *is* the relation's declaration** — the explicit
form does not "add to" an inferred relation, it replaces inference for that field.

### 2.3 Relations — inference rules (precise)

- `declare author: Author` -> many-to-one. The **FK column derives from the field
  name** (`author` -> `author_id`), the **target from the type** (`Author` -> `author`
  table). Rails-identical: `belongs_to :author` -> `Author`.
- `declare comments: Comment[]` -> one-to-many (inverse).
- **Two relations to the same target are NOT ambiguous.** `declare author: User` and
  `declare editor: User` each get their own FK column from their own field name
  (`author_id`, `editor_id`), both targeting `users`. Field name disambiguates the
  column; the type names the target. This works implicitly.
- **The one real ambiguity is the self-referential inverse:** `declare parent:
  Category` infers (`parent` -> `parent_id`), but a sibling `declare children:
  Category[]` cannot be inferred as *the inverse of `parent`* — the type carries no
  direction. This case is a **build diagnostic** telling the user to annotate
  (`@jsails.hasMany(Category, { inverse: 'parent' })`). Never guessed.

## 3. Mechanism — proven, not assumed

### 3.1 Inference is compiler-driven, convention-based

**Types are erased at runtime.** The only thing that can read `declare author: Author`
is the compiler. That is the connection to "we have a compiler."

**Proven precedent:** `src/compiler/resolve-components.ts` already resolves cross-file
references **by convention + existence check** — a capitalized tag `Counter` resolves
to `app/components/counter.js` by kebab-case name and a filesystem existence probe,
*without a TypeScript checker*. The compiler is pure string transforms
(`rolldown/utils` `parseSync` -> ESTree); there is **no `ts.createProgram`, no
LanguageService**.

Therefore model inference uses the **same convention-based resolution**:

- `declare author: Author` -> property type name `Author` -> `models/author.ts` by
  kebab-case convention (existence-checked). Rails' `belongs_to :author` -> `Author`
  is the identical mechanism; convention-over-configuration is the correct, proven
  answer, not a compromise.
- `declare comments: Comment[]` -> array element type -> one-to-many.
- `declare title: string` / `number` / `boolean` / `Date` -> scalar column kinds.

**Honest limit:** this is convention + source-text parsing, not semantic inference.
Union types (`Author | null`), generics, mapped types, and imported aliases
(`import { Author as A }`) are **out of scope for v1** — they are reported as
`unresolved_model` diagnostics (value-free) rather than guessed. The inline decorator
is the escape hatch for anything inference cannot express.

### 3.2 Lowering target — TypeORM's own metadata storage

**PROVEN by spike (2026-10-13).** A class carrying `@Entity`/`@Column`/`@ManyToOne`
writes into TypeORM's global `getMetadataArgsStorage()`, which reports:

```
tables= [ 'author', 'post' ]
columns(post)= [ 'id:regular', 'title:regular' ]
relations= [ 'Post.author:many-to-one' ]
```

That storage is exactly what the portable-schema builder reads
(`src/database/model-schema.ts` -> `getMetadataArgsStorage()`),
so **migrations need no change**.

**CRITICAL correction the spike forced:** an `EntitySchema` instance does **NOT**
write into `getMetadataArgsStorage()` (spike printed `tables=0 relations=[]`) — it is
resolved separately when the data source is built. Therefore **the compiler must emit
decorator-equivalent registration, not a constructed `EntitySchema`.** The lowering
target is the decorator/`getMetadataArgsStorage()` path.

This is *wrapping* TypeORM, never rebuilding it — the governing principle. The compiler
call into TypeORM's decorator internals is an **implementation detail hidden inside
the framework**; the user writes JSails decorators (`@jsails.*`), never TypeORM's, and
often writes none at all (pure inference).

**PROVEN emit mechanism (2026-10-13, second spike): invoke TypeORM's own decorator
factories programmatically.** TypeORM's decorators are ordinary functions returning
property/class decorators, so generated registration calls them directly instead of
re-declaring decorator syntax in user source:

```ts
Entity('post')(Post);
PrimaryGeneratedColumn()(Post.prototype, 'id');
Column({ type: 'varchar', length: 200, nullable: false })(Post.prototype, 'title');
ManyToOne(() => Author, (a) => a.posts, { nullable: false })(Post.prototype, 'author');
JoinColumn({ name: 'author_id' })(Post.prototype, 'author');
```

This produced byte-identical portable schema to hand-written decorators:
`id:integer PK, author_id:integer, title:varchar(200)` plus the FK
`author_id -> author.id`. It is **version-stable** (public decorator API, not
TypeORM's internal `getMetadataArgsStorage()` arg shapes — an earlier spike proved
hand-pushing raw arg objects is fragile: the PK `generated` flag silently drops).
`BaseEntity` static queries keep working because the class itself is the registered
target. This is the mechanism the compiler emits; the user's source carries only
JSails decorators or nothing.

### 3.3 Decorator path lowers onto existing hook factories

`touch`, `counter_cache`, `encrypts`, `autosave`, `nestedAttributes` already return
`EntityHooksDefinition[]` (`src/database/associations.ts`,
`src/database/attribute-encryption.ts`). Relation decorators with behaviour
(`@jsails.belongsTo(Author, { touch: true })`) lower onto these — **no new
subsystem**, the factories stay the substrate. Column decorators
(`@jsails.maxLength`) lower onto TypeORM column-option metadata.

## 4. What the compiler emits

For `models/post.ts`, the compiler produces a registration module. **Decision
(locked): the generated module is pure data** — it carries no `typeorm` import and
no decorator-factory calls. It imports the user's model classes and calls a tested
runtime helper `defineModel(Class, spec)` (`src/models/define-model.ts`) that performs
the lowering:

```ts
// .jsails/models.registry.ts  (generated — pure data)
import { defineModel } from 'jsails/models';
import { Post } from '../models/post.js';
import { Author } from '../models/author.js';

defineModel(Post, {
  table: 'post',
  primaryKey: { name: 'id', kind: 'integer' },
  columns: [
    { name: 'title', type: 'varchar', length: 200, nullable: false },
    { name: 'views', type: 'integer', nullable: false },
  ],
  relations: [
    { kind: 'many-to-one', name: 'author', target: Author, joinColumn: 'author_id', nullable: false },
  ],
});
```

`defineModel` is the **only** place the TypeORM factory sequence lives (the sequence
proven in §3.2). It applies the decorator-equivalent metadata, collects hook
definitions, and calls `registerModel(Class, hooks)` so the runtime harvest (§2)
picks it up.

**Why data + `defineModel` rather than emitting TypeORM calls directly** (the plan's
original Option A): the generated artifact then contains no TypeORM at all, so the
axiom ("TypeORM is an implementation detail") holds literally; the lowering is
ordinary unit-tested TypeScript with a real test, not an untested string emitter;
and TypeORM version drift is fixed in one place instead of in every scaffolded app's
generated output.

### 4.1 The build step — one source scan, one owner, two artifacts

**The original assumption ("the same build-time mechanism that already exists for
module discovery") does not hold for server models.** The starter compiles server
code — including `models/` — with `tsc -p tsconfig.json`; Vite/rolldown only ever
sees the *client* bundle. `compilerPlugin`/`autoloadPlugin` are Vite transforms and
never touch `models/*.ts`. And implicit inference *requires* codegen, because types
are erased at runtime.

There is also a pre-existing ordering defect in the autoload subsystem: the
`.jsails/imports.*.d.ts` ambient declarations are written by the Vite plugin's
`buildEnd`, i.e. **after** `tsc` has already run — so a clean build's `tsc` never
sees its own declarations (only `tsc --watch` picks them up later). The scan reads
*compiled* `.js` via `await import()`, which is why it can only run post-`tsc`.

Both defects share one root cause: **the scan reads compiled output.** The fix is to
make the scan **source-level and pre-`tsc`**, which breaks the cycle and lets one
walk feed both consumers.

```
jsails build:meta            (new standalone step; runs BEFORE tsc)
  walk source once:  app/**  server/**  shared/**  models/**  components/**
                     (parseSync — no import)
    ├─ autoload symbols  → .jsails/imports.{app,server}.d.ts   (pre-tsc, for typecheck)
    ├─ autoload symbols  → .jsails/autoload.json               (Vite transform consumes)
    ├─ model specs       → .jsails/models.registry.ts          (tsc compiles it)
    └─ component specs   → .jsails/components.registry.ts      (tsc compiles it)
tsc -p tsconfig.json         → dist/.jsails/{models,components}.registry.js
runtime: bootstrapModels() / bootstrapComponents()
                             → auto-import the compiled registries before use
```

Consequences (all intended):

- `autoloadPlugin` stops scanning; it **reads** `.jsails/autoload.json` and keeps only
  its `transform` hook. The Vite plugin becomes a consumer of the precomputed registry.
- `scanAutoload`'s `await import()` (which executes app top-level code at scan time) is
  **replaced by `parseSync`** — a build scan must not run app code. This is a genuine
  semantic change; the affected autoload tests are rewritten (§8).
- Starter scripts prepend `jsails build:meta`; `dev` runs it before `tsc`; the tsconfig
  `include` gains `.jsails/models.registry.ts` and `.jsails/components.registry.ts`.
- `JsailsDataSource` stays free of build-layout knowledge; `bootstrapModels()` owns the
  registry path and is called by the config loaders (`loadAppConfig`, migration/console/
  test/seed loaders) — **zero user wiring**, per the user directive.
- **Component registry (scope decision, locked).** The same walk emits
  `.jsails/components.registry.ts`; a runtime `registerComponent(component)` in
  `jsails/server-components` collects them, and `serverComponentsPlugin()` becomes
  **zero-arg** (auto-resolves the registry via `bootstrapComponents()`). This deletes
  the hand-written `app/registry.ts` and its `jsails.app.js` import — the last manual
  registry in the starter.
- **`src/compiler/conventions.ts` (scope decision, locked).** One table is the single
  source of truth for convention-derived paths and names (N1 dirs, autoloadable
  prefixes, `models/<kebab>`, `components/<kebab>`, `jobs/<kebab>`, route file→URL).
  `make:*`, the autoload scan, model resolution, and component resolution all import
  it, so the four current copies cannot drift.

**Loading is automatic.** The user never imports a registry. `bootstrapModels()` /
`bootstrapComponents()` are the single seams that "find and import the registry"; the
config loaders call them before constructing a `JsailsDataSource` / running extensions.

## 5. `EntitySchema` is demoted to internal

JSails supports two model dialects today (class + `EntitySchema`) only because TypeORM
has both — that is an implementation detail leaking. Under the axiom:

- **Models are classes.** The class is the sole authoring surface.
- **`EntitySchema` remains internal** — an implementation JSails may construct under
  the hood from class metadata. It is **removed from the public model-authoring docs
  and generators**; it may stay exported for advanced/internal use but is no longer a
  taught path.

**Note (spike-corrected):** since `EntitySchema` does not register into
`getMetadataArgsStorage()` (§3.2), it is *not* the lowering target for implicit models
— the decorator path is. `EntitySchema` remains available only as an internal
alternative for cases that need it; the compiler emits decorator-equivalent metadata.

## 6. Files touched

| File | Change |
|---|---|
| `src/compiler/` | New model-extraction pass: class shape -> entity + relations + hooks. Convention resolver mirroring `resolve-components.ts`. New `unresolved_model` / `ambiguous_relation` diagnostics. |
| `src/compiler/model-*.ts` | (new) parser, convention resolver, emitter |
| `src/compiler/conventions.ts` | (new) single source of truth for convention-derived paths/names; consumed by `make:*`, autoload scan, model + component resolution |
| `src/build/meta-scan.ts` + `generate-meta.ts` | (new) the unified source scan + artifact emitter (§4.1) |
| `src/compiler/autoload-scan.ts` | Rewrite to `parseSync` source parsing; the Vite plugin reads the precomputed registry |
| `src/compiler/autoload-plugin.ts` | Drop scanning; consume `.jsails/autoload.json`; keep `transform` |
| `src/models/define-model.ts` | (new) `defineModel(Class, spec)` — the only place the TypeORM factory sequence lives |
| `src/models/bootstrap.ts` | (new) `bootstrapModels()` — auto-imports the compiled registry |
| `src/server-components/registry.ts` | (new) `registerComponent()` + `bootstrapComponents()`; `serverComponentsPlugin()` becomes zero-arg |
| `src/models/index.ts` | New `jsails` namespace; rewrite the doc-block (currently leaks TypeORM at line 11) |
| `src/database/application-record.ts` | The JSails-owned `ApplicationRecord` base (already landed) |
| `src/database/data-source.ts` | Harvest compiler-emitted registrations into `entities`/`subscribers` (already landed) |
| `src/cli/` | New `build:meta` command; config loaders call `bootstrapModels()`/`bootstrapComponents()` |
| `templates/starter/` | `package.json` scripts + `tsconfig` include; models use the new shape; delete `app/registry.ts`; no TypeORM in user models |
| `website/content/docs/conventions.md` | Model section -> the implicit shape; delete the factory/`createEntitySubscriber` teaching |
| `website/content/docs/data-layer.md` | Update authoring examples; keep query/relations/migrations semantics |
| `website/content/docs/*` | Any other TypeORM-leaking model example |

## 7. Migration compatibility (must verify end-to-end)

**Risk:** if a compiler-emitted registration registers relations in a way the
autodetector doesn't read, `makemigrations` silently misses an FK.

**Verification:** a round-trip test — implicit model -> `getModelSchema()` ->
assert columns/relations/FKs exactly match the equivalent hand-written TypeORM model.
Do this **first**, before wiring the compiler, so the lowering target is proven.

## 8. Tests

- `test/compiler/model-extract.test.ts` — class shape -> entity/relations/hooks;
  convention resolution; `unresolved_model` on unions/generics/aliases; self-referential
  inverse diagnostic.
- `test/build/meta-scan.test.ts` — one source walk emits both `.jsails/imports.*.d.ts`
  and `.jsails/models.registry.ts`; `export *` re-exports resolve within the scanned set.
- `test/compiler/autoload-scan.test.ts` (rewrite) — `parseSync` source extraction;
  no module execution at scan time.
- `test/models/bootstrap.test.ts` — `bootstrapModels()` imports the compiled registry
  and populates the model registry; idempotent; absent registry is a no-op.
- `test/models/implicit-model.test.ts` — implicit model through `JsailsDataSource`:
  columns, FK, one-to-many, same-target-two-fields (`author`/`editor`), queries work.
- `test/models/field-decorators.test.ts` — inline decorators: `maxLength`, `unique`,
  `nullable`, `encrypts`; relation behaviour `touch`, `counter_cache`.
- `test/database/model-schema-roundtrip.test.ts` — §7: implicit == hand-written.
- `test/cli/make-model.test.ts` — generated model uses the implicit shape, compiles.

## 9. Autoload — maximize the safe set (user directive: "as much as possible")

"Everything autoload" is **not literally achievable**: Node ESM has no
`const_missing`-style hook, and the Vite `transform` hook sees source *text*, not
types, so a bare identifier's origin is unresolvable without a module resolver it
lacks. `autoloadPlugin` can only inject a name a **prior scoped scan** enumerated.

But **"as much as the scan can safely cover" is achievable**, and that set is strictly
larger than today's. The safe boundary is: *project-local directories whose files
contribute an unambiguous, convention-based symbol name.*

### 9.1 Widening (from -> to)

| Today | Widened |
|---|---|
| `app/`, `server/`, `shared/` (root only) | all three, **recursively** |
| `app/composables/`, `app/utils/`, `server/utils/` | + `models/`, `components/`, `serializers/`, `middleware/`, `jobs/`, `validators/`, `services/` — **every convention-resolvable project dir** |
| — | framework symbols injectable by name (e.g. `jsails.belongsTo`) so model decorators need no import |

**Stays out, deliberately:** `node_modules` (unbounded), and any dir whose symbols are
not unambiguously resolvable. "As much as possible" done right = maximize coverage while
preserving the uniqueness guarantee (`IDENTIFIER_RE` + collision rejection) that makes
injection safe. A name collision is a **build diagnostic**, never a silent wrong import.

### 9.2 One walk, two consumers

The compiler already walks the project tree for component resolution and autoload
scanning. The model-extraction pass (§3.1) walks the same tree. **Do not walk it
twice** — one directory walk feeds one symbol registry that drives **both**
autoload injection and model inference. This is the "do it right" answer: the model
pass and the autoload pass are two projections of the same traversal, not two systems.

### 9.3 Scope guard

Widening autoload is folded into this workstream **only where the compiler already
walks the tree**. Runtime magic (intercepting arbitrary identifiers) remains impossible
and is not attempted.

## 10. Docs-as-API correction

Because the public surface *is* the API, this workstream is also a **docs correction**:
the canonical model example (§2.1) must be the thing that actually runs. Deliverable:
`conventions.md` and `data-layer.md` show the implicit shape and nothing that imports
TypeORM.

## 11. Sequencing

1. **§7 round-trip proof** — implicit registration -> `getModelSchema()` equals
   hand-written. (De-risks everything.) — **DONE**
2. `ApplicationRecord` base + harvest in `JsailsDataSource`. — **DONE**
3. Compiler model-extraction pass + convention resolver. — **DONE**
4. Unified source scan (`build:meta`) + `bootstrapModels()` + `bootstrapComponents()` + wiring. — **IN PROGRESS**
5. Field/relation decorators lowering onto TypeORM column options + hook factories.
6. `make:model` template + starter.
7. Docs rewrite.
8. Full quartet.

## 12. Verification

Serial single-owner lane: `npm run build:clean` -> `npm run check` (expect 6200+ /
**0 fail**) -> `npm run verify:starter -- --skip-browser` -> `npm run format` ->
`npm run lint` -> `node scripts/check-src-structure.mjs` -> `npm run build` ->
`npm --prefix website run check`.
