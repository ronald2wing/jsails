---
title: Client & Islands
order: 7
---

# Client & Islands

`jsails/client` is the **browser-safe** runtime. It owns hydration, Turbo soft
navigation, and the server-component bindings, so your browser entry stays tiny:
register your islands, call `startClient()`, and let the framework drive the
rest. There is **no automatic module discovery** — every island must be
registered explicitly.

## Starting the client

`startClient(options?)` dynamically imports `@hotwired/turbo`, starts the shared
Turbo session, registers any declarative `islands` map, hydrates the initial
island markup, and auto-enables the server-component bindings. It is idempotent,
and a failed start tears down listeners/islands and remains retryable.

```tsx
// client/main.tsx  (app-owned browser entry)
import { registerIsland, startClient } from 'jsails/client';
import { Counter } from './counter';

registerIsland('counter', Counter);
startClient();
```

The starter's whole browser entry is exactly this shape: register the `counter`
island once, then `startClient()`. There is no manual `hydrate`, `fetch`, or
`history` call.

## Registering islands

`registerIsland(name, component)` registers a typed Preact island. The same name
with the same component is a no-op; a different component under an existing name
throws. You can also pass a declarative map to `startClient`:

```ts
startClient({ islands: { counter: Counter } });
```

Islands are server-rendered elements carrying two markers:

- `data-jsails-island="name"` — the registered island name.
- `data-jsails-props` — bounded JSON props.

The element `id` is required only for `data-turbo-permanent`.

## Hydration

`data-hydrated="true"` is set on hydrate and removed on restore, but hydration is
tracked per element **identity** (a `WeakMap`), never by the attribute alone. A
cache restore or Turbo clone can carry the attribute without a live Preact root,
so the runtime never trusts the marker by itself.

A hydration or render error is reported (default `console.warn`, or `onError`)
and that island is skipped; the rest of the document keeps hydrating.

## Island props

Island props are decoded with `JSON.parse` only, bounded by length, depth, and
key count. The decoder rejects `__proto__`, `constructor`, and `prototype` keys
at any depth, so a hostile `data-jsails-props` payload cannot pollute the
prototype chain.

## Turbo soft navigation

Turbo owns all link interception and history: the runtime installs no bespoke
click handler, `history` call, or router. Ordinary valid same-origin `<a href>`
links get Turbo soft navigation over server-rendered (SSR) **and** plain static
(SSG) pages, including back/forward.

Native opt-outs are left to the browser's default full navigation:

- external origin
- `download`
- `target`
- a modified left-click
- `data-turbo="false"`

There is **no HMR** — `dev` rebuilds and you reload the browser; the client
runtime does not patch modules.

## Morphing components

`morphComponent(target, html, options?)` renders a Turbo stream message and
resolves once it lands; `MorphComponentOptions.action` now accepts the full
`TurboStreamAction` set — `replace`, `update`, `append`, `prepend`, `remove`,
`before`, `after`, `refresh` — so a single call covers every Turbo Stream action.
Use `morphComponent` when a server response should update an existing DOM subtree.

## Turbo Streams builders

`jsails/client` exports pure `<turbo-stream>` string builders with no DOM or
Turbo dependency, safe to call server-side:

- `turboStreamMessage(action, target, html?)` — the generic builder.
- `replaceStream(target, html)`, `updateStream(target, html)`,
  `appendStream(target, html)`, `prependStream(target, html)`,
  `beforeStream(target, html)`, `afterStream(target, html)` — content actions
  taking a CSS selector and HTML.
- `removeStream(target)`, `refreshStream(target)` — structural actions taking
  only a CSS selector.

Every helper returns a serialized `<turbo-stream>` element and is trusted
producer output — the caller owns HTML escaping.

## Before-navigation hook

A cancelable `jsails:before-navigation` document event (plus an `onBeforeNavigation`
hook) fires before a navigation commits, so a runtime can drop stale in-flight
work.

```ts
document.addEventListener('jsails:before-navigation', (event) => {
  // Cancel the navigation, or abort in-flight requests.
  event.preventDefault();
});
```

## Hotwire Native groundwork

`src/client/native.js` adds a pure-path configuration layer for Hotwire Native
mobile-web hybrids, with no native SDK dependency.

- `definePathConfiguration(rules)` builds a `PathConfiguration` from
  application- or pattern-matched `PathRule`s.
- `resolvePathConfiguration(config, path)` returns the best-matching rule for a
  given path.
- `resolvePathConfigurationMerged(config, url)` merges every matching rule
  (later wins); `defaultPathRules()` returns the standard recede/resume/refresh
  historical-location rules.
- `isNativeApp()` detects whether the client is running inside a native app's
  web view from its `User-Agent`.

```ts
import {
  definePathConfiguration,
  isNativeApp,
  resolvePathConfiguration,
} from 'jsails/client';

const config = definePathConfiguration([
  { patterns: ['/new$'], properties: { context: 'modal' } },
]);

if (isNativeApp()) {
  const rule = resolvePathConfiguration(config, '/posts/new');
}
```

`nativeBridge` is a stub object (type only) — JSails ships no bridge adapter, and
native bridge integration is the app's responsibility.

## Next steps

- [Authentication](/docs/auth) — the first-party auth plugin and session flow.
