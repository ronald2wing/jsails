/**
 * Contract tokens: first-class, typed capability declarations with replacement
 * semantics and versioning — distinct from {@link ServiceToken}, not a flag on it.
 *
 * A contract token carries an internal {@link ServiceToken} that registers the
 * actual implementation value in the service registry, so the existing registry
 * handles storage with no changes. Providers call `services.provide(contract.token,
 * impl)` during `setup`; consumers call `contract.resolve(services)` to obtain the
 * typed implementation. The runner owns the topological ordering and the
 * provider-count-plus-override checks over `provides`/`requires` declarations.
 */

import { createServiceToken, type ServiceRegistry, type ServiceToken } from './services.js';

declare const contractTokenBrand: unique symbol;

/**
 * A typed capability declaration: a contract that zero or more extensions may
 * provide, at most one non-override provider plus at most one override. The
 * brand is compile-time only, so tokens are safe to keep, pass around, and
 * compare by identity.
 */
export interface ContractToken<T> {
  /** Developer-facing label used in error messages only. */
  readonly name: string;
  /** Positive integer; default 1. Metadata for plugin authors, not enforced. */
  readonly version: number;
  /** Phantom type slot; never present at runtime. */
  readonly [contractTokenBrand]: T;
  /** The service token that backs this contract in the registry. */
  readonly token: ServiceToken<T>;
  /** Typed, synchronous resolve from a service registry. */
  resolve(registry: ServiceRegistry): T;
}

/**
 * Options for {@link createContractToken}. Version defaults to 1 and must be a
 * positive integer.
 */
export interface CreateContractTokenOptions {
  readonly version?: number;
}

/**
 * Create a new contract token. Each call produces a distinct identity even when
 * `name` repeats; the name is a label for diagnostics, not a key.
 */
export function createContractToken<T>(
  name: string,
  options: CreateContractTokenOptions = {},
): ContractToken<T> {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('contract token name must be a non-empty string');
  }
  const version = options.version ?? 1;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new TypeError('contract token version must be a positive integer');
  }
  const token = createServiceToken<T>(name);
  return Object.freeze({
    name,
    version,
    token,
    resolve: (registry: ServiceRegistry): T => registry.get(token),
  }) as unknown as ContractToken<T>;
}

/**
 * A provides entry on an extension: which contract the extension fulfills. When
 * `override` is `true` this entry replaces a default provider for the same
 * contract; multiple overrides for one contract is a load-time error.
 */
export interface ContractTokenProvider {
  readonly contract: ContractToken<unknown>;
  /**
   * When `true`, this entry replaces any earlier (default) provider for the
   * same contract. The override's implementation wins — it is what consumers
   * resolve. Defaults to `false`.
   */
  readonly override?: boolean;
}

/**
 * Type guard: `true` when `value` is shaped like a contract token (an object
 * with a non-empty string `name` and a positive-integer `version`). Used by
 * the shared validation pass so `requires` entries that happen to be contracts
 * pass the token-shape check unchanged.
 */
export function isContractToken(value: unknown): value is ContractToken<unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { name?: unknown; version?: unknown };
  if (typeof candidate.name !== 'string' || candidate.name.trim() === '') return false;
  if (
    typeof candidate.version !== 'number' ||
    !Number.isInteger(candidate.version) ||
    candidate.version < 1
  ) {
    return false;
  }
  return true;
}
