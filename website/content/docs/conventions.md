---
title: Conventions
order: 2
section: Orientation
---

# Conventions

JSails delivers Rails-style ergonomics through **convention, generators, a
declarative model DSL, and a generated autoload layer** — so project code needs
no imports. This page explains the mental model so a new project reads like a
framework, not a pile of imports.

## How conventions are chosen

Every convention here is a deliberate choice, reached the same way. We adopt an
idea only when it is a good idea, and we build it properly rather than taking the
easy path. Ergonomics are a means, never an excuse to ship a wrong or
half-thought-through design. When a feature is hard to build well, the answer is
to build it well — not to skip it because the easy path is shorter, and not to add
it because implementation is cheap. Each surface below is a decided answer,
documented with its rationale and its limits so the trade-off is visible rather
than implicit.

## No import: the data layer is already available

The whole data layer is **installed as globals**, so a server module uses the
Active Record base, query expressions, validation, jobs, and encryption with no
import line at all:

```ts
// models/post.ts — no import; the symbols below are globals.
export class Post extends ApplicationRecord {
  @Column('varchar', { length: 255 }) title!: string;
}

const hot = await query(Post).where(qGt('likes', 10)).getMany();
```

`ApplicationRecord`, `query`, `qGt`, `defineEntityValidation`, `validateFields`,
`defineJob`, and the rest are projected onto `globalThis` by the preload
(`jsails/symbols`), and the generated ambient `.d.ts` declares them so `tsc`
type-checks a bare reference (see
[Autoloading: no imports for project code](#autoloading-no-imports-for-project-code)
below).

When you _want_ an explicit import — a browser module, a plain Node script, or a
symbol you prefer to see in the file — every subpath (`jsails/database`,
`jsails/jobs`, `jsails/api`, `jsails/validation`, …) re-exports the same surface
from a browser/server-appropriate barrel, so you never hunt for which subpath a
symbol lives in. Imports are **optional**, not wrong; bare globals are the
default.

## Models are declarative

A model is a class that declares only the shape of its data. It extends the
project-local `ApplicationRecord` (re-exporting `BaseEntity`), so class-level
queries are available without a repository — and the compiler derives the table,
columns, foreign keys, and migrations from the class. TypeORM never appears in a
model: no `@Entity`/`@Column`, no subscriber to wire, no `entities` entry to
maintain.

```ts
// `ApplicationRecord` is installed as a global — no import needed.
export class Post extends ApplicationRecord {
  declare title: string; // -> varchar(255)
  declare published: boolean; // -> boolean
  declare author: Author; // -> many-to-one; column author_id -> author
  declare comments: Comment[]; // -> one-to-many (inverse)
}
```

The base class and the escape hatches come from **one specifier**,
`jsails/models`. When inference cannot know the intent, decorate a field in place
with an inline `@jsails.*` decorator — no import; the compiler reads it
statically:

```ts
export class Post extends ApplicationRecord {
  @jsails.maxLength(200) declare title: string;
  @jsails.unique() declare slug: string;
  @jsails.nullable() declare summary: string;
  @jsails.encrypts() declare body: string;

  @jsails.belongsTo(Author, { touch: true }) declare author: Author;
  @jsails.hasMany(Comment, { counter_cache: true }) declare comments: Comment[];
}
```

- A bare scalar lowers by its TypeScript type: `string` → `varchar(255)`,
  `number` → `integer`, `boolean` → `boolean`, `Date` → `datetime`.
- A bare field typed with another model lowers to a **many-to-one** FK
  (`declare author: Author` → column `author_id`); a `Model[]` field lowers to a
  **one-to-many** inverse.
- `@jsails.maxLength(n)` / `@jsails.unique()` / `@jsails.nullable()` adjust a
  column; `@jsails.encrypts()` folds the field into the model's encryption set
  (the key comes from `JSAILS_ENCRYPTION_KEY`).
- `@jsails.belongsTo(Author, options)` / `@jsails.hasMany(Comment, options)`
  replace inference for a relation and carry its behaviour (`touch`,
  `counter_cache`, `inverse`), lowering onto the same hook factories the
  imperative DSL exposes.

The class and file names fix the table — `Post` → `post`, `BlogPost` →
`blog_post` — and the primary key is generated for you (never declare `id`). Add
a field, then run `jsails db:push` to reconcile the database.

Under the hood `jsails/models` is a convenience re-export, not a wrapper. The
TypeORM decorators (`Column`, `Entity`, …) and the `jsails/database` DSL helpers
(`belongs_to`, `has_many`, `has_one`, `delegate`,
`accepts_nested_attributes_for`, `encrypts`) stay reachable from the same
specifier as the escape hatch for a hand-written entity; `defineModel` (spec in,
entity out) is the seam the compiler emits onto. The implicit shape above is the
path the framework and the generators use.

- `belongs_to` / `has_many` / `has_one` take the entity and register the relation,
  returning hook definitions that, per option, wire the lifecycle bridges
  (`touch`, `counter_cache`, `dependent`) — one call, not a `@OneToMany` decorator
  plus a manual subscriber.
- `delegate(methods, { to, prefix?, allow_nil? })` returns a **class decorator**
  (`@delegate(...)`) that forwards getters and methods through a relation, binding
  `this` to the target and failing value-free on a missing relation unless
  `allow_nil: true`.
- `accepts_nested_attributes_for` and `encrypts` are the same hook-definition
  factories — spread them into the subscriber's hook array.

## Autoloading: no imports for project code

Rails auto-loads constants with Zeitwerk, which relies on Ruby's `const_missing`
hook and a deterministic file↔constant convention. **Node ESM has neither**: an
unqualified identifier is a `ReferenceError` (there is nothing to intercept), and
`import` requires an explicit specifier. JSails closes that gap with a
**generated autoload layer** rather than asking you to hand-write the glue.

The project-local **N1 tree** is genuinely auto-imported. A module placed under
one of these directories is available by name, with no import:

| Directory                                          | Context | Notes                                             |
| -------------------------------------------------- | ------- | ------------------------------------------------- |
| `app/composables/`, `app/utils/`                   | app     | client-safe helpers                               |
| `shared/`                                          | app     | client-safe values shared by server and client    |
| `server/`                                          | server  | server-only modules                               |
| `models/`                                          | server  | Active Record models                              |
| `ui/`                                              | app     | Preact components and layout                      |
| `jobs/`, `commands/`, `extensions/`, `components/` | server  | jobs, CLI commands, extensions, server components |

`pages/` and `api/` are **consumers**, not providers: they read autoloaded
symbols but are never themselves published as globals.

`jsails build:meta` scans the tree, extracts each module's named value exports,
and emits two artifacts into `.jsails/`:

- **`.jsails/project-symbols.js`** — a preload that installs the framework symbols, then
  dynamically imports each provider's shim in dependency order. `jsails serve`,
  `jsails build`, and `jsails dev` preload it automatically; a plain Node script
  (like the static starter's feed generator) opts in with
  `node --import ./.jsails/project-symbols.js`.
- **`.jsails/project-symbols/*.js`** — one shim per provider module that imports the
  compiled module and publishes its exports onto `globalThis`, after first
  importing the shims of any providers it references.

The generated `.jsails/project-symbols.app.d.ts` and `.jsails/project-symbols.server.d.ts`
declare every autoloaded symbol as a global, so `tsc` type-checks a bare
reference with no import. A symbol referenced from a client-safe context may only
resolve to another client-safe symbol; a server-only symbol is reachable from
server code only.

```ts
// server/content.ts — a provider; no import of its own symbols needed.
export const posts = await defineContentCollection({ dir: 'content/posts' });

// pages/index.tsx — a consumer; `posts` and `Layout` are bare.
export function load() {
  return { posts };
}
export default function Home() {
  return <Layout>{/* ... */}</Layout>;
}
```

Everything outside the N1 tree is reached by _convention_ plus **generators**:
the framework's own globals, a single base class, declarative model factories,
and `jsails make:*` commands that emit import-complete, compilable files.
Framework authoring entry points (`defineModel`, `defineJob`,
`defineContentCollection`, …) are themselves installed as globals, so a model or
job file needs no import either.
Third-party packages (`zod`, `preact`, …) are never autoloaded — they stay
explicit imports. This is also why a third-party name can never be shadowed by a
framework global: the projection only ever publishes names the framework itself
exports.

**Two projections: server and browser.** The framework's own exports are
projected onto `globalThis` at two entry points, split by whether a subpath is
safe to load in a browser:

- **Server** — `jsails serve`/`build`/`dev` preload `.jsails/project-symbols.js`,
  whose first act is `installFrameworkSymbols()` (from `jsails/symbols`). It projects
  every framework subpath's exports, so `Application`/`BaseEntity`/`query`/… are
  bare in any module.
- **Browser** — a client entry calls `installBrowserSymbols()` (from
  `jsails/symbols/client`) once before hydration. It projects only the
  **browser-safe** subpaths (`jsails/api`, `jsails/client`, `jsails/theme`,
  `jsails/i18n`, …) — never a server-only one (`jsails/database`, `jsails/jobs`,
  `jsails/server-components`), so a projected name can never drag TypeORM,
  BullMQ, or Better Auth into the client bundle.

Both share one collision/override engine (one namespace object per colliding
subpath; a changed value warns once and wins; an identical re-install is silent),
so a name resolves the same way in either target. A server-only name is still
usable in the browser — just by explicit `import`, never bare.

## Generators write the imports for you

`jsails make:*` emits an **import-complete, compilable** file in the conventional
directory, so a generated file compiles against a fresh scaffold with no further
editing:

```sh
jsails make:model post           # models/post.ts — extends ApplicationRecord
jsails make:page about-us        # pages/about-us.tsx — wired to the Layout
jsails make:api health           # api/health.ts — a read-only GET route
jsails make:job send-reminder    # jobs/send-reminder.ts — a Zod-validated job
jsails make:command report       # commands/report.ts — a CLI command
jsails make:server-component todo # components/todo.tsx — a live server component
jsails make:serializer post      # serializers/post.ts — a field serializer
jsails make:middleware cache     # middleware/cache.ts — a route middleware
```

Each generated file follows the starter's own conventions. Because the N1 tree is
autoloaded, a generated file that references a sibling provider needs no import
for it — only third-party packages stay explicit.

## Declarative plugins and resources

The same "one object is the whole thing" idea extends to plugins and API
resources, so the imperative wiring is collapsed into a single declarative spec:

```ts
// A plugin as data: services, HTTP hooks, and commands without manual setup.
import { clockToken } from './tokens.js';

export const clock = defineDeclarativePlugin({
  name: 'clock',
  requires: [/* ... */],
  provide: [[clockToken, { now: () => new Date().toISOString() }]],
  http: (app) => app.get('/time', (c) => c.json({ now: Date.now() })),
});

// An API resource as data: serializer + store + authorize in one object.
export const posts = defineDeclarativeResource({
  name: 'post',
  serializer: { id: number(), title: string(), body: optional(string()) },
  store,
  authorize: resourcePolicy({ list: require(isStaff) }),
});
// posts.serializer / posts.handlers / posts.routes / posts.authorize
```

`defineDeclarativePlugin` and `defineDeclarativeResource` are thin wrappers over
the existing `definePlugin` and `defineSerializer`/`createResourceHandlers`/
`createResourceRouter` primitives — they reshape a declarative object into the
imperative wiring, never reimplement the engine.

Three further shorthands collapse the remaining boilerplate:

- **`defineStoreResource({ slug, store, serializer })`** (`jsails/admin`) builds an
  admin resource whose `list`/`get`/`save` are derived from a `ResourceStore`, so a
  database-backed CRUD shares one store/serializer with the API side.
- **`defineSimpleComponent(name, { fields, run, render })`** (`jsails/server-components`)
  derives the Zod `stateSchema` and `writableKeys` from a `fields` map and collapses
  actions to a single `run` — the fast path for a form, toggle, or counter.
- **`defineComponent({ stateSchema, actions, derived, style, render })`**
  (`jsails/server-components`) is the friendly authoring surface for a full
  component: `actions` split by capability into `serverAction` (round-trips through
  the snapshot) and `localAction` (pure, client-runnable), `derived` view values,
  and a `defineStyle` named-slot style contract. It lowers onto
  `defineServerComponent`, which stays the primitive. The three artifacts — model,
  view, style — can live in one file or several; a component with server-only code
  must split client-safe from `*.server` so the build's clean-bundle assertion
  holds. See [Server components](/docs/server-components) for the shapes and the
  client-safe vs server-only seam.
- **`defineAppConfig(appConfigSchema, config)`** (`jsails`) validates the top-level
  app-config shape against a Zod schema, returning typed config with value-free errors
  for a typo or wrong-typed field.

## Next steps

- [Architecture](/docs/architecture) — how the framework is assembled.
- [Models](/docs/models) — the declarative Active Record model surface.
