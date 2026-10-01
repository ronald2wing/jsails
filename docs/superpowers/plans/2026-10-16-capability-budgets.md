# Shapes as presets: SSG ↔ full, one app, zero re-scaffolding

**Status:** final model locked (implementation in progress)
**Owner:** lead
**Date:** 2026-10-16

## Resolved model

The capability/"mode" question collapses to **one plugin declaration** +
**preset sugar** + **a report**. No per-surface annotation, no `requires`/
`provisions` budget, no surface `kind` enum.

Why: runtime null-degradation already answers capability resolution (verified —
`resolveSessionOrNull` → `session: null`; `services.tryGet` fail-closed), and the
starter pages already degrade via `renderMode: 'static'`.

### 1. Plugin runtime (the only declaration)

`PluginDescription.needsLive?: boolean` (absent = runs both):

- `needsLive: true` — full shapes only (auth/jobs/broadcast/server-components).
- absent — static and full (content/seo/theme/i18n, mail/cache memory).

A **boolean**, not a ternary: "needs live?" is the single deployment-shape axis.
A build-time-only concern is not a runtime plugin (it belongs to the build
toolchain, as `tsc`/`vite build` do) — a different axis than the plugin runtime
surface, so a third `'static'` value would abstract an empty set and blur that
boundary.

### 2. `shape` preset

`shape: 'static' | 'full' | 'cli'` in `jsails.app.js` — sugar over `plugins.use`:

- `static` → exclude `'live'` plugins (the static closure).
- `full` → include `'live'` plugins.
- `cli` → no web surface.

Admin/blog are plugins, not shapes. The closure derives from `runtime: 'live'`,
never a hard-coded list.

### 3. Report (the only new feature surface)

`describe`/`inspect` (or `jsails app:shape <target>`) lists, for a target `use`
list: which plugins are live-only (from `runtime`), and which surfaces degrade
(from the existing null-defaults). Pure derivation — no new mechanism.

## Non-goals

No per-surface `requires`, no `stage`/`mode` enum beyond the `shape` preset, no
capability-budget list, no `app:mode` mutation command.

## File structure never changes

The one-file-structure principle holds: switching `shape` never regenerates the
project; pages/content/components stay put; live-only surfaces degrade (session
null) exactly as they already do under a partial `use` list.