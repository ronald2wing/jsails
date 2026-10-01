/**
 * Feature flags: the core boolean-gate model shared by the stores and the
 * plugin.
 *
 * A flag is identified by a non-empty `key` plus an optional `scope` (a
 * string/id). The global scope (no `scope` argument) and each scoped namespace
 * are independent: the same key can be active for one scope and inactive
 * elsewhere. A flag is always boolean — a gate is either active or inactive —
 * and reads default to inactive when nothing was ever stored.
 *
 * The {@link FeatureStore} contract is the single seam every backing store
 * implements: `get` returns `null` when a flag is unset (so "explicitly off"
 * and "never set" stay distinguishable at the store level, even though both
 * resolve to inactive through {@link FeatureFlags.isActive}). This module is
 * deliberately ORM-free — it imports no TypeORM, HTTP, or queue runtime — so a
 * custom store can persist flags anywhere.
 */

/** Maximum length of a flag key, shared by the memory store and the DB column. */
export const FLAG_KEY_MAX_LENGTH = 190;

/** Maximum length of a flag scope, shared by the memory store and the DB column. */
export const FLAG_SCOPE_MAX_LENGTH = 190;

/**
 * Raised for every feature-flag failure that reaches a caller. Messages are
 * value-free: a key, scope, or backend detail is never echoed, so a caller may
 * surface them verbatim.
 */
export class FeatureFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeatureFlagError';
  }
}

/**
 * A feature-flag store: the persistence seam the service and the plugin share.
 * Implementations own their backing medium (memory, database, ...) and validate
 * every key, scope, and value value-free.
 */
export interface FeatureStore {
  /** Read a flag, or `null` when it is unset in that scope. */
  get(key: string, scope?: string): Promise<boolean | null>;
  /** Write a flag's boolean value in a scope (the global scope when omitted). */
  set(key: string, value: boolean, scope?: string): Promise<void>;
  /** Remove a flag from a scope; a no-op when it was never set. */
  delete(key: string, scope?: string): Promise<void>;
  /** All flags and their boolean values within a scope (global when omitted). */
  all(scope?: string): Promise<Record<string, boolean>>;
}

/**
 * The service the `flags` plugin provides: resolve a flag's boolean state and
 * flip it without a deploy. Defaults to inactive when a flag is unset.
 */
export interface FeatureFlags {
  /** Whether the flag is active in a scope; inactive when unset. */
  isActive(key: string, scope?: string): Promise<boolean>;
  /** Mark the flag active in a scope (the global scope when omitted). */
  activate(key: string, scope?: string): Promise<void>;
  /** Mark the flag inactive in a scope (the global scope when omitted). */
  deactivate(key: string, scope?: string): Promise<void>;
  /** All flags and their boolean values within a scope (global when omitted). */
  all(scope?: string): Promise<Record<string, boolean>>;
}

/**
 * A resolved flag: branch between the active and the inactive value. The
 * `??` composition picks whichever branch the flag selects.
 */
export interface FeatureResolution {
  /** Resolve to `value` when the flag is active, else `undefined`. */
  active<T>(value: T): Promise<T | undefined>;
  /** Resolve to `value` when the flag is inactive, else `undefined`. */
  inactive<T>(value: T): Promise<T | undefined>;
}

/** Assert a flag key is a non-empty string within the length bound. Value-free. */
export function assertFlagKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > FLAG_KEY_MAX_LENGTH) {
    throw new FeatureFlagError(
      `a feature flag key must be a non-empty string of at most ${FLAG_KEY_MAX_LENGTH} characters`,
    );
  }
}

/** Assert a flag scope is `undefined` or a non-empty string within the bound. Value-free. */
export function assertFlagScope(scope: unknown): asserts scope is string | undefined {
  if (scope === undefined) {
    return;
  }
  if (typeof scope !== 'string' || scope.length === 0 || scope.length > FLAG_SCOPE_MAX_LENGTH) {
    throw new FeatureFlagError(
      `a feature flag scope must be a non-empty string of at most ${FLAG_SCOPE_MAX_LENGTH} characters`,
    );
  }
}

/** The in-process scope key used by the memory store (empty string = global). */
function scopeKey(scope: string | undefined): string {
  return scope ?? '';
}

/**
 * Create an in-memory {@link FeatureStore}: the zero-config default for tests,
 * demos, and single-process deployments. It holds no external resources and
 * scopes are isolated namespaces — a flag set in one scope never leaks into
 * another or the global scope.
 */
export function createMemoryFeatureStore(): FeatureStore {
  const scopes = new Map<string, Map<string, boolean>>();

  const get = async (key: string, scope?: string): Promise<boolean | null> => {
    assertFlagKey(key);
    assertFlagScope(scope);
    const value = scopes.get(scopeKey(scope))?.get(key);
    return value === undefined ? null : value;
  };

  const set = async (key: string, value: boolean, scope?: string): Promise<void> => {
    assertFlagKey(key);
    assertFlagScope(scope);
    if (typeof value !== 'boolean') {
      throw new FeatureFlagError('a feature flag value must be a boolean');
    }
    const keyed = scopeKey(scope);
    let bucket = scopes.get(keyed);
    if (bucket === undefined) {
      bucket = new Map();
      scopes.set(keyed, bucket);
    }
    bucket.set(key, value);
  };

  const remove = async (key: string, scope?: string): Promise<void> => {
    assertFlagKey(key);
    assertFlagScope(scope);
    const keyed = scopeKey(scope);
    const bucket = scopes.get(keyed);
    if (bucket === undefined) {
      return;
    }
    bucket.delete(key);
    if (bucket.size === 0) {
      scopes.delete(keyed);
    }
  };

  const all = async (scope?: string): Promise<Record<string, boolean>> => {
    assertFlagScope(scope);
    const bucket = scopes.get(scopeKey(scope));
    if (bucket === undefined) {
      return {};
    }
    return Object.fromEntries(bucket);
  };

  return { get, set, delete: remove, all };
}

/**
 * Build a {@link FeatureFlags} service over a {@link FeatureStore}. This is the
 * wiring the plugin uses; the store owns validation and persistence, while the
 * service adds the active/inactive vocabulary. Exported for the plugin, not
 * part of the `jsails/flags` public surface.
 */
export function createFeatureFlags(store: FeatureStore): FeatureFlags {
  return {
    async isActive(key, scope) {
      return (await store.get(key, scope)) === true;
    },
    async activate(key, scope) {
      await store.set(key, true, scope);
    },
    async deactivate(key, scope) {
      await store.set(key, false, scope);
    },
    async all(scope) {
      return store.all(scope);
    },
  };
}

/**
 * Resolve a flag into an `{ active, inactive }` branch over a
 * {@link FeatureFlags} service. Compose with `??` to select one branch:
 *
 * ```ts
 * const feature = resolveFeature(flags, 'new-checkout', session.userId);
 * return (await feature.active(newUi())) ?? (await feature.inactive(oldUi()));
 * ```
 *
 * The key and scope are validated eagerly (synchronously); the store is read
 * lazily on the first `active`/`inactive` call.
 */
export function resolveFeature(
  flags: FeatureFlags,
  key: string,
  scope?: string,
): FeatureResolution {
  assertFlagKey(key);
  assertFlagScope(scope);
  return {
    async active<T>(value: T): Promise<T | undefined> {
      return (await flags.isActive(key, scope)) ? value : undefined;
    },
    async inactive<T>(value: T): Promise<T | undefined> {
      return (await flags.isActive(key, scope)) ? undefined : value;
    },
  };
}
