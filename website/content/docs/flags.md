---
title: Feature Flags
order: 30
section: Reference
---

# Feature Flags

`jsails/flags` is a boolean gate the app flips without a deploy. It covers two
layers: the core boolean-gate store (in-memory or database-backed) for simple
on/off toggles, and the **flag-scope primitives** (`coverage`, `beforeAfter`,
`when`) for A/B testing and gradual rollouts.

A flag is identified by a non-empty `key` plus an optional `scope` (a string or
id). The global scope and each scoped namespace are independent — the same key
can be active for one scope and inactive elsewhere. Scoped flags are the
foundation for per-tenant, per-user, and per-session toggles.

The `jsails/flags` subpath is imported explicitly (`import { resolveFeature, coverage } from 'jsails/flags'`). Importing the barrel is inert: nothing connects and no flag is
read or written until a store or service method is called.

See [Presentation & Toggles](/docs/presentation) for the high-level overview of
flags alongside theme tokens and i18n; this page covers the full surface.

## The boolean-gate store

### Memory store

`new MemoryFeatureStore()` is the zero-config default for tests, demos, and
single-process deployments. It holds no external resources and scopes are
isolated namespaces — a flag set in one scope never leaks into another or the
global scope.

### Database store

`new DatabaseFeatureFlagStore({ dataSource })` persists flags in the
`jsails_feature_flag` table. The entity (`JsailsFeatureFlag`) maps four columns:
`key` (varchar 190), `scope` (varchar 190), `value` (boolean), and `updatedAt`
(datetime). Add `featureFlagEntities` to a `JsailsDataSource` `entities` and run
`jsails db:push` — the store reads and writes only through the injected data
source's repository (no raw SQL, no runtime DDL). A missing table fails with a
value-free `FeatureFlagError` pointing at that command.

```js
// jsails.config.js  (app-owned; plain ESM)
import { JsailsDataSource, featureFlagEntities } from 'jsails';
import { User } from './entities/user.js';

export default new JsailsDataSource({
  type: 'mariadb',
  /* ... */
  entities: [...featureFlagEntities, User],
});
```

```sh
jsails db:push --config jsails.config.js
```

### The `FeatureStore` contract

Every store implements the same contract:

```ts
interface FeatureStore {
  get(key: string, scope?: string): Promise<boolean | null>;
  set(key: string, value: boolean, scope?: string): Promise<void>;
  delete(key: string, scope?: string): Promise<void>;
  all(scope?: string): Promise<Record<string, boolean>>;
}
```

`get` returns `null` when a flag is unset — "explicitly off" and "never set"
stay distinguishable at the store level even though both resolve to inactive
through the service. This contract is ORM-free: a custom store can persist flags
anywhere.

## The service

The `flags` plugin exposes a `FeatureFlags` service under the typed `flagsToken`
service token:

```ts
interface FeatureFlags {
  isActive(key: string, scope?: string): Promise<boolean>;
  activate(key: string, scope?: string): Promise<void>;
  deactivate(key: string, scope?: string): Promise<void>;
  all(scope?: string): Promise<Record<string, boolean>>;
}
```

`isActive` returns true only when the stored value is exactly `true`; absent or
`false` both resolve to inactive.

### Through the plugin

```js
// jsails.app.js  (app-owned; plain ESM, compiled JS)
import { flagsPlugin } from 'jsails/flags';

export default {
  plugins: {
    use: [
      'jsails/flags',            // in-memory default
      // or with a database store:
      ['jsails/flags', { store: new DatabaseFeatureFlagStore({ dataSource }) }],
    ],
  },
};
```

With an explicit `store`, it is used verbatim (identity preserved) and the
plugin never closes it. Without one, the plugin owns a zero-config
`MemoryFeatureStore`. Construction is inert — nothing connects and no flag is
read or written until a service method is called.

### Branch resolution

`resolveFeature(flags, key, scope?)` returns an `{ active, inactive }` branch
helper that reads the store lazily on the first branch call:

```ts
import { resolveFeature } from 'jsails/flags';

const feature = resolveFeature(flags, 'new-checkout', session.userId);

// Compose with ?? to select one branch:
return (await feature.active(newUi())) ?? (await feature.inactive(oldUi()));
```

The key and scope are validated eagerly (synchronously); the store is read only
when `active()` or `inactive()` is called.

## Flag scopes (A/B testing)

`jsails/flags` exports a set of pure, browser-safe scope primitives: functions
that map a `scope` string to a boolean, determining whether a variant is active
for that scope. They are deterministic — the same scope always resolves the same
way, never flapping between variants.

Scopes compose with the boolean-gate store via `resolveFeature` (for persisted
toggles) or the pure `when()` helper (for in-memory branch selection).

### How bucketing works

Every scope function derives its answer from a deterministic **FNV-1a** hash of
`key + "\0" + scope`. The hash produces a stable integer in `[0, 2^32)`, so the
same scope always lands in the same bucket — a user's A/B cohort is stable
across requests and sessions. An empty scope string always returns `false`.

### `coverage(percent, key)`

Activate a variant for a stable percentage of scopes. `percent` is in `[0, 100]`;
a scope whose bucketed hash falls under that percentage is in.

```ts
import { coverage } from 'jsails/flags';

// 20% of users see the new checkout.
const scope = coverage(20, 'new-checkout-exp');
scope('user-abc'); // might be true or false, but always the same for 'user-abc'
```

### `everyone(key)` and `nobody(key)`

`everyone(key)` is `coverage(100, key)` — activate for every scope.
`nobody(key)` is `coverage(0, key)` — activate for no scope.

### `beforeAfter(key, before, step?)`

Pick a variant by an ordered rollout step. `before` is the total number of
buckets; `step` (default `1`) selects which bucket is "after" (the new variant).
Buckets are split evenly across `[0, 2^32)`, so `step = 1` of `10` means the
first 10% of scopes see the new variant.

```ts
import { beforeAfter } from 'jsails/flags';

const scope = beforeAfter('search-v2-rollout', 10, 2);
// After two steps of a 10-step rollout: 20% of scopes see the new variant.
```

### `shipped`

A scope that is always active — the final step of a rollout where the feature is
permanently on for everyone.

```ts
import { shipped } from 'jsails/flags';

const scope = shipped;
scope('any-user'); // always true
```

### `when(scope, scopeValue, active, inactive)`

A synchronous branch helper: returns `active` when the scope resolves true for
`scopeValue`, else `inactive`. The unused branch is never evaluated — pass thunks
for expensive values.

```ts
import { when, coverage } from 'jsails/flags';

const scope = coverage(50, 'pricing-experiment');

const price = when(
  scope,
  'user-42',
  () => computeNewPrice(), // only called when scope resolves true
  () => computeOldPrice(),
);
```

## Error handling

`FeatureFlagError` is value-free — a key, scope, or backend detail is never
echoed. Validation rejects:

- A key that is not a non-empty string within `FLAG_KEY_MAX_LENGTH` (190 chars).
- A scope that is not `undefined` or a non-empty string within
  `FLAG_SCOPE_MAX_LENGTH` (190 chars).
- A `coverage` percent not in `[0, 100]`.
- A `beforeAfter` `before` not a positive integer, or `step` not in
  `[0, before]`.

## Honest limits

- **No real-time scope updates.** The `coverage`/`beforeAfter` primitives are
  pure functions — they derive their answer from a hash of the key + scope. To
  change the coverage percentage mid-experiment, change the `key` (or accept
  that existing scopes will re-bucket). This is deliberate: a pure-function
  primitive has no mutable state and no store dependency.
- **Scopes are strings only.** A scope value must be a string — no numeric or
  object scopes. This keeps the hashing simple and reproducible.
- **No auto-rollout manager.** There is no framework-owned rollout state machine
  that advances `step` automatically. The `beforeAfter` step is a parameter the
  caller updates in code.
- **The `FeatureStore` contract has no batch operations.** `set` and `delete`
  are single-key. Bulk toggles require multiple calls.

## Next steps

- [Presentation & Toggles](/docs/presentation) — theme tokens and i18n alongside
  flags.
- [Extending JSails](/docs/extending) — consume `flagsToken` from your own
  extension via `requires: [flagsToken]`.