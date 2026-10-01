---
title: Why we built JSails
date: '2026-01-12'
tags:
  - framework
  - ssg
  - php
category: Design
excerpt: JSails is a small, typed data layer plus a static-export pipeline — not another full-stack framework.
---

Every framework conversation starts with the same question: what do we actually
need? For us the answer was narrow. We wanted a data layer we could reason about
and a build that turns Markdown into a deployable site without a runtime server
standing in the way.

## The problem with frameworks that do everything

A framework that ships its own ORM, router, template engine, auth stack, and
queue is convenient right up until the moment you disagree with one of its
choices. Then you are either fighting the framework or forking it.

JSails takes the opposite path. It reuses maintained libraries where they are
already good, and only fills the gaps that are genuinely ours:

- **TypeORM** for the data layer instead of a bespoke ORM
- **Zod** for runtime validation instead of hand-rolled guards
- **Preact** for rendering instead of a custom VDOM
- **Hono** for HTTP instead of a homegrown router

That list is the whole philosophy. Everything else is glue.

## A content layer that fits

The static blog you are reading right now is powered by `jsails/content`. It
discovers every Markdown file under a directory, validates frontmatter against a
schema, and renders it once:

```ts
import { defineContentCollection } from 'jsails/content';

const posts = await defineContentCollection({
  dir: 'content/posts',
  schema: z.object({ title: z.string(), date: z.string() }),
});
```

No database, no server, no plugin. The build reads the files and writes HTML.

## What comes next

We are keeping the surface small on purpose. If a feature can live in a plugin,
it lives in a plugin. If it can be a plain function, it is a plain function. The
framework should disappear into your application, not stand in front of it.
