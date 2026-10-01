---
title: Getting Started
order: 1
---

# Getting Started

JSails is a **TypeORM-based Active Record data layer** plus a bounded application
runtime: an extension system, HTTP/pages/API serving, static export, jobs,
broadcast, deploy-config generators, and a CLI. It is deliberately *not* a
complete MVC framework — it reuses maintained libraries (TypeORM, Zod, BullMQ,
Socket.IO, Preact, Hono) rather than rebuilding a renderer, an auth stack, or a
queue.

## Prerequisites

- **Node.js** `^20.19.0 || ^22.13.0 || >=24.11.0` (ESM only)
- **MariaDB** (recommended) — or Postgres, MySQL, or SQLite for the data layer

## Installation

JSails is not published to npm yet. Install the CLI from a framework source
checkout by building and packing it, then pointing `create` at the tarball:

```sh
npm run build
npm pack --pack-destination /tmp
jsails create my-app --install --jsails-dependency "file:/tmp/jsails-1.0.0.tgz"
```

Then run the development server:

```sh
cd my-app
npm run dev     # compile + watch + serve (restarts the backend on changes)
```

## Starter shapes

`jsails create` scaffolds one Preact starter in a few shapes. All of them always
ship auth; the rest are opt-in:

- **default (auth-only)** — local email/password sign-in over Better Auth, a
  `counter` island, a live `task-list` server component, and Home/About/Tasks pages.
- **`--admin`** — adds the first-party admin panel.
- **`--blog`** (implies `--admin`) — adds a database-backed blog and two blog pages.
- **`--cli`** — a Laravel-Zero-style CLI-only project (no web surface) on the same
  framework and plugin system.
- **`--static`** — a pure static-site (SSG) starter with no server plugins.

## Build & serve

- `npm run dev` — compiles TypeScript + Vite, then serves with automatic restart
  when compiled JS or the app config changes. There is **no HMR** — reload the
  browser after a change.
- `npm run build` — compiles the server and client, then runs `jsails build`
  (static export) to emit built pages into `out/`.
- `npm test` — the native `node:test` suite; `npm run test:browser` is the optional
  Playwright UI suite.

## Application config — `jsails.app.js`

The app is described by a single compiled ESM module whose default export is a
plain object:

```js
export default {
  rootDir: '.',      // defaults to the config file's directory
  pages: 'pages',    // relative to rootDir
  api: 'api',        // relative to rootDir
  public: 'public',  // relative to rootDir
  out: 'out',        // static export destination
  storage: 'storage', // resolved to storageDir, created on serve
  healthPath: '/up',  // GET/HEAD 200; false disables
  host: '127.0.0.1',
  port: 3000,        // 0 requests an ephemeral port
};
```

`host`, `port`, and `out` come from the config, never CLI flags.

## Database config — `jsails.config.js`

Migrations drive on a compiled ESM config whose default export is a
`JsailsDataSource`. Models are **Active Record classes** extending the
project-local `ApplicationRecord` (a thin re-export of the framework `BaseEntity`,
so `.find` / `.save` / `.create` are available as static methods with no extra
import). Write a model with `jsails make:model` and register it:

```js
import { JsailsDataSource, readDatabaseEnvironment } from 'jsails';
import { Post } from './app/application-record.js';

export default new JsailsDataSource({
  ...readDatabaseEnvironment(),
  entities: [Post],
});
```

```ts
// app/application-record.js — the project-local Active Record base
export { BaseEntity as ApplicationRecord } from 'jsails';

// models/post.ts — a declarative Active Record model
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { ApplicationRecord } from '../app/application-record.js';

@Entity('posts')
export class Post extends ApplicationRecord {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 255 })
  title!: string;
}
```

`readDatabaseEnvironment` reads `DATABASE_HOST`, `DATABASE_USER`,
`DATABASE_PASSWORD`, `DATABASE_NAME`, and `DATABASE_PORT` (MariaDB defaults to
`3306`). It never loads a `.env` file or mutates `process.env`.

You rarely hand-write the TypeORM decorators: `jsails make:model post` generates
an import-complete model, and the declarative DSL (`belongs_to` / `has_many` /
`delegate` / `accepts_nested_attributes_for`) keeps relations and forwarding
concise — see [conventions](/docs/conventions).

## Next steps

- [Conventions](/docs/conventions) — the declarative model DSL, generators, and why
  JSails uses scaffolding instead of autoloading.
- [Data Layer](/docs/data-layer) — entities, the portable schema, and migrations.
- [Pages & Routing](/docs/pages-and-routing) — your first page and API route.