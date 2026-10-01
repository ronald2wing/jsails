---
title: Conventions
order: 2
---

# Conventions

JSails delivers Rails-style ergonomics through **convention, generators, and a
declarative model DSL** — not through runtime autoloading. This page explains the
mental model so a new project reads like a framework, not a pile of imports.

## One import, everything available

The whole data layer is reachable from a single specifier. Write it once at the
top of a file and use the Active Record base, query expressions, validation,
jobs, and encryption without further ceremony:

```ts
import {
  BaseEntity,
  query,
  defineEntityValidation,
  validateFields,
  defineJob,
} from 'jsails';
```

Every subpath (`jsails/database`, `jsails/jobs`, `jsails/api`, `jsails/validation`,
…) re-exports the same surface from a browser/server-appropriate barrel — you almost
never need to remember which subpath a symbol lives in.

## Models are declarative

A model extends the project-local `ApplicationRecord` (re-exporting `BaseEntity`),
so class-level queries are available without a repository. Relations, forwarding,
and nested persistence are declared with a Rails-style DSL rather than hand-rolled
decorator graphs:

```ts
import { Column, Entity } from 'typeorm';
import {
  ApplicationRecord,
  belongs_to,
  has_many,
  delegate,
  accepts_nested_attributes_for,
  encrypts,
} from '../app/application-record.js';

@Entity('posts')
export class Post extends ApplicationRecord {
  @Column({ type: 'varchar', length: 255 })
  title!: string;

  belongs_to('author', { touch: true });
  has_many('comments', { counter_cache: true, dependent: 'destroy' });
  accepts_nested_attributes_for('comments');

  delegate('author_name', { to: 'author', method: 'name' });

  encrypts('body');
}
```

- `belongs_to` / `has_many` / `has_one` register the relation and, per option,
  wire the lifecycle bridges (`touch`, `counter_cache`, `dependent`) — one line,
  not a `@OneToMany` decorator plus a manual subscriber.
- `delegate(methods, { to, prefix?, allow_nil? })` forwards getters and methods
  through a relation, binding `this` to the target and failing value-free on a
  missing relation unless `allow_nil: true`.
- `accepts_nested_attributes_for` and `encrypts` are the same one-line hooks.

## Generators write the imports for you

Because Node ESM requires explicit imports and has no constant-autoloading hook,
the framework writes the boilerplate instead of asking you to. `jsails make:*`
emits an **import-complete, compilable** file in the conventional directory:

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

Each generated file follows the starter's own conventions, so it compiles against
a fresh scaffold with no further editing.

## Declarative plugins and resources

The same "one object is the whole thing" idea extends to plugins and API
resources, so the imperative wiring is collapsed into a single declarative spec:

```ts
// A plugin as data: services, HTTP hooks, and commands without manual setup.
import { defineDeclarativePlugin } from 'jsails/extensions';
import { clockToken } from './tokens.js';

export const clock = defineDeclarativePlugin({
  name: 'clock',
  requires: [/* ... */],
  provide: [[clockToken, { now: () => new Date().toISOString() }]],
  http: (app) => app.get('/time', (c) => c.json({ now: Date.now() })),
});

// An API resource as data: serializer + store + authorize in one object.
import { defineDeclarativeResource } from 'jsails/api';

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
- **`defineAppConfig(appConfigSchema, config)`** (`jsails`) validates the top-level
  app-config shape against a Zod schema, returning typed config with value-free errors
  for a typo or wrong-typed field.

## Why generators, not autoloading

Rails auto-loads constants with Zeitwerk, which relies on Ruby's `const_missing`
hook and a deterministic file↔constant convention. **Node ESM has neither**: an
unqualified identifier is a `ReferenceError` (there is nothing to intercept), and
`import` requires an explicit specifier. JSails therefore expresses the same ease
as *convention* — a single base class, a one-line import, declarative class methods,
and generators that write the glue. The result is that you never hand-write
boilerplate, even though the mechanism is scaffolding rather than magic.