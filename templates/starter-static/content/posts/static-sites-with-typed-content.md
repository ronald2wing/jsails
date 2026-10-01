---
title: Static sites with typed content
date: '2026-02-03'
tags:
  - ssg
  - typescript
  - content
category: Engineering
excerpt: A content collection validates frontmatter at build time, so a typo in a date field fails the build instead of shipping a broken page.
---

Static site generators are wonderful until content stops being trivial. The
moment a page needs a date, a list of tags, or a hidden draft flag, you are
doing ad hoc string parsing in a template — and the failure mode is a silently
broken page.

## Frontmatter is an interface

The fix is to treat frontmatter as a typed interface rather than loose YAML.
`jsails/content` accepts a Zod schema and validates every entry against it before
a single page renders:

```ts
const schema = z.object({
  title: z.string(),
  date: z.string(),
  tags: z.array(z.string()).default([]),
  excerpt: z.string().optional(),
});
```

If a post is missing a title, or a tag is the wrong shape, the build fails with
a field-level error naming the file. You never ship the broken page.

## Derived data for free

Once the collection knows every page, the useful things fall out of it:

- **Static paths** — `getStaticPaths()` enumerates the real slugs for the export
- **Prev/next** — neighbours in a deterministic order, no index bookkeeping
- **Reading time** — derived from the rendered HTML, always at least one minute
- **Taxonomies** — a tag index built by grouping on a frontmatter field

None of these require a database or a build plugin. They are pure functions over
an already-discovered graph.

## The payoff

The build is the type checker for your content. A green build means every page
has the shape it claims to have, which is a much stronger guarantee than "it
looked right in the preview."
