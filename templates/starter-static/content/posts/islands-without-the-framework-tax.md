---
title: Islands without the framework tax
date: '2026-03-18'
tags:
  - preact
  - ssg
  - javascript
category: Engineering
excerpt: A blog does not need a client bundle. When interactivity is genuinely local, register one island and let Turbo handle the rest.
---

A content site is mostly reading. Shipping a full client-side application to
render text is a tax the reader pays in megabytes for a feature they may never
touch. Islands invert that default: the page is static HTML, and only the
genuinely interactive parts hydrate.

## Start from zero JavaScript

This blog ships no islands at all. `client/main.tsx` calls `startClient()` and
nothing else, which means the browser runtime does exactly one job: own soft
navigation through Turbo. Ordinary links become fast in-place swaps; the back
and forward buttons work; nothing is re-rendered that did not change.

```tsx
startClient().catch((error) => {
  console.error('jsails: client startup failed', error);
});
```

That is the entire browser entry. No router, no hydration pass over content,
no virtual DOM diffing text that will never change.

## Add interactivity where it earns its keep

When a page really does need local state, an island is one `registerIsland`
call and a matching marker in the server markup. The runtime hydrates only that
element:

```tsx
registerIsland('counter', (props) => <Counter initial={props.initial} />);
```

The server renders the same component to HTML, so the first paint is instant and
hydration is a matching pass over a single node.

## What you avoid

- No automatic module discovery, so no accidental bundles
- No hot module replacement pretending to be correctness
- No client framework re-rendering content it was handed as a string

The result is a site that loads as fast as its assets and stays interactive only
where it matters.
