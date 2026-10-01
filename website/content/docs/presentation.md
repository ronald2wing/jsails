---
title: Presentation & Toggles
order: 24
section: Reference
---

# Presentation & Toggles

Presentation & Toggles covers three seams, each with its own subpath: theme
tokens (`jsails/theme`), feature flags (`jsails/flags`), and
internationalization (`jsails/i18n`).

The `jsails/theme` subpath is a **browser-safe** CSS custom-property token
contract shared by the admin renderer, the generated starter, and plugin
authors. It has no I/O and no `node:*` imports, so the module is safe for
client-side code. A "toggle" here means a presentation toggle — switching the
active named theme through `[data-theme]` blocks — not a feature flag or a
locale; those live in their own subpaths, covered below.

## Core tokens

`coreThemeTokenNames` is the frozen array of the five fixed core tokens:

- `--jsails-bg`
- `--jsails-fg`
- `--jsails-accent`
- `--jsails-muted`
- `--jsails-border`

These names are semver-visible API: the admin renderer and the starter layout
reference them directly. The open `--jsails-*` namespace accepts any custom
property following that pattern, but only the core set is guaranteed to be
consumed by every surface.

## Deriving tokens from a seed

`deriveThemeTokens(seed)` derives the five core tokens from a `{ primary,
radius? }` seed via a dependency-free HSL transform. `primary` becomes
`--jsails-accent`; the remaining tokens are derived by varying lightness and
saturation. Hex colors produce a harmonic palette; a non-hex primary gets
sensible neutral defaults. The optional `radius` sets `--jsails-radius`.

```ts
import { deriveThemeTokens } from 'jsails/theme';

const tokens = deriveThemeTokens({ primary: '#2563eb', radius: '0.5rem' });
// => { '--jsails-bg': ..., '--jsails-fg': ..., '--jsails-accent': ...,
//      '--jsails-muted': ..., '--jsails-border': ..., '--jsails-radius': '0.5rem' }
```

## Resolving themes

Themes are an **ordered fold, not a parent graph**. `resolveThemeTokens(app,
contributions, options?)` folds four precedence layers, lowest to highest:

1. An implicit empty base `{}`.
2. Unnamed contributions, in registration order (spread-overwrite).
3. The **active** named theme's effective tokens, when `options.active` names
   one.
4. Application tokens (spread-overwrite, highest).

Two contributions sharing the same `name` are spread-merged
(`...earlier, ...later`) — later wins per key, never an error. There is no
`parent` field, no parent-graph resolution, and no `conflict`/`cycle`/
`unknown_parent` errors. The result is a `ThemeResolution`
`{ active, themes, activeName }` with every named theme's effective map
available in `themes`.

```ts
import { resolveThemeTokens } from 'jsails/theme';

const resolution = resolveThemeTokens(
  { '--jsails-accent': '#dc2626' }, // app tokens, highest precedence
  [
    { name: 'ocean', tokens: { '--jsails-accent': '#0891b2' } },
    { tokens: { '--jsails-radius': '0.25rem' } }, // unnamed contribution
  ],
  { active: 'ocean' },
);

resolution.activeName; // 'ocean'
resolution.active; // the folded active map
resolution.themes; // { ocean: { '--jsails-accent': '#0891b2' } }
```

## Emitting CSS

`themeTokensToCss(resolution)` emits `:root { active tokens }` plus one
`[data-theme="<name>"] { ... }` block per named theme (sorted), hardened against
control characters and `</style` injection. It returns `''` when empty. The
`[data-theme]` blocks are what make a runtime theme switch a pure presentation
toggle: flip the `data-theme` attribute on `<html>` and the browser repaints.

```ts
import { resolveThemeTokens, themeTokensToCss } from 'jsails/theme';

const css = themeTokensToCss(resolveThemeTokens(appTokens, contributions, { active }));
// => ":root { --jsails-bg: ...; }\n[data-theme=\"ocean\"] { --jsails-accent: #0891b2; }"
```

## The `ThemeTokens` service

`createThemeTokens(app, contributions, options?)` wraps `resolveThemeTokens`
into a `ThemeTokens` service with `resolve()` (frozen active map), `toCss()` (all
blocks), `themes()` (named maps), and `activeName()`.

## Wiring the plugin

`themePlugin({ tokens?, contributions?, active? })` exposes the resolved
`ThemeTokens` under the typed `themeToken` service token. `options.tokens` is the
application layer (highest precedence); `options.contributions` collects
`ThemeContribution` entries from each plugin's `PluginDescription.theme`
descriptor (inert declarative metadata, never resolved at import time);
`options.active` selects the initial active theme. Construction is inert — no
tokens resolve until `setup` runs.

```js
// jsails.app.js  (app-owned; plain ESM, compiled JS)
import { themePlugin } from 'jsails/theme';

export default {
  plugins: {
    use: [
      ['jsails/theme', { active: 'ocean' }],
    ],
  },
};
```

The admin panel consumes the theme service through an optional
`tryGet(themeToken)`, and its `theme` option (`'light' | 'dark' | 'system'`)
maps to the document's `data-theme` attribute. The starter `Layout` renders
`ThemeTokens.toCss()`, which includes the full `[data-theme]` blocks for runtime
theme switching.

## Feature flags

`jsails/flags` is a boolean gate the app flips without a deploy. A flag is a
non-empty `key` plus an optional `scope` (a string/id); the global scope and
each scoped namespace are independent, so the same key can be active for one
scope and inactive elsewhere.

- `MemoryFeatureStore` is the zero-config in-memory `FeatureStore`
  default for tests, demos, and single-process deployments.
- `DatabaseFeatureFlagStore({ dataSource })` persists flags through the
  injected data source's repository, mapping the framework-owned
  `jsails_feature_flag` table. The table must already exist — a missing table
fails with a `FeatureFlagError` pointing at `jsails db:push`; the
store never creates it.
- `resolveFeature(flags, key, scope?)` resolves a flag into an `{ active,
  inactive }` branch over a `FeatureFlags` service; compose with `??` to select
  one branch. The key and scope are validated eagerly; the store is read lazily
  on the first branch call.
- `flagsPlugin({ store? })` exposes a `FeatureFlags` service under the typed
  `flagsToken`. With an explicit `store` it is used verbatim (identity
  preserved, never closed); otherwise the plugin owns the in-memory default.

`FeatureFlagError` is value-free — a key, scope, or backend detail is never
echoed. Construction is inert: nothing connects and no flag is read or written
until a store or service method is called.

```ts
import { MemoryFeatureStore, resolveFeature } from 'jsails/flags';

const flags = new MemoryFeatureStore();
const feature = resolveFeature(flags, 'new-checkout', 'user:42');
const view = (await feature.active(newUi())) ?? (await feature.inactive(oldUi()));
```

## Internationalization

`jsails/i18n` is a **dependency-free** message layer over nested string maps. The
browser-safe translator is `MessageTranslator`; the server-only half adds catalog
loading, a plugin, and a global `I18n` facade.

`new MessageTranslator({ messages, locale?, fallbackLocale?, onMissing? })`
returns a `Translator` with:

- `t(key, options?)` resolves a dot-path key (`nav.home`) against the active
  locale's map, then the fallback locale's, and interpolates `{name}` (plus
  Laravel-style `:name` / `:Name` / `:NAME` case variants). `options` may carry
  a `scope` (string or array of dot segments, folded onto the key) and an ordered
  `default` (a literal, another `{ key }`, or an array tried left-to-right).
  `t(keys[])` resolves a batch in order. Returns the key itself when missing.
- `tChoice(key, count, options?)` selects a plural form with the built-in
  `Intl.PluralRules` for the locale — a plural key maps to an object keyed by
  category (`one`, `few`, `many`, `other`, ...), never a bespoke index.
- `exists(key, options?)` reports whether a key resolves (no default applied).
- `localize(value, options?)` / `l(value, options?)` format a date, time,
  datetime, number, currency, or percent through `Intl` (currency requires an
  ISO 4217 `currency` code). This is an addition Laravel does not have.
- `locale()` / `fallbackLocale()` / `withLocale(next)` read the active/fallback
  locales or derive a translator with a new locale.

The translator holds the passed `messages` reference and never mutates it.
`locale` and `fallbackLocale` are validated eagerly; a malformed locale throws a
value-free `I18nError`. Errors never echo a locale string.

```ts
import { MessageTranslator } from 'jsails/i18n';

const t = new MessageTranslator({ messages, locale: 'en', fallbackLocale: 'en' });
t('nav.home');
t('date.formats.short', { scope: 'date.formats' });   // same key, scope-folded
tChoice('cart.items', 3);
t.localize(new Date(), { dateStyle: 'long' });          // "March 14, 2023"
```

### Catalogs, the plugin, and the global `I18n`

For an app, load catalogs from flat `lang/en.json` files or nested group files and
wire the ambient global:

```ts
// jsails.app.js
export default {
  i18n: { locale: 'en', fallbackLocale: 'en', loadPaths: ['lang'] },
};

// any page or API (inside a request)
I18n.t('nav.home');             // per-request locale, ambient scope
I18n.l(new Date(), { dateStyle: 'long' });
```

The `i18n` config block builds the `i18nPlugin` automatically, which provides a
`Loader` (filesystem or in-memory), resolves the request locale (via
`resolveLocale`), and publishes the `I18n` facade. Bare `t`/`l`/`choice` re-exports
are available for the terse `import { t } from 'jsails/i18n/server'` form. A
read-only `jsails i18n:missing` command reports keys used in code but absent from
catalogs (CI-gateable). See [CLI](/docs/cli) and
[Extending](/docs/extending).

## Next steps

- [Utility Services](/docs/services) — the cluster of small focused services.
- [Observability](/docs/observability) — logging, signals, diagnostics, and watchers.
