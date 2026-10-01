/**
 * Service tokens and the registry that backs the extension system.
 *
 * A service token is an opaque, typed identity: the token object itself is the
 * lookup key, so two tokens created with the same name are still distinct
 * services. The phantom `T` carries the service's value type from the
 * `createServiceToken<T>(name)` call to every `get`/`tryGet`/`provide`, so the
 * registry stays dynamically keyed while consumers stay typed.
 *
 * The registry is plain — a `Map`, no reflection, no decorators, no global
 * state. `createServiceRegistry` returns a small controller so the runner can
 * read services, register them, seal the registrar after setup, and wipe the
 * map on shutdown.
 */

declare const serviceTokenBrand: unique symbol;

/**
 * An opaque handle to a service of type `T`. The brand is compile-time only,
 * so tokens are safe to keep, pass around, and compare by identity.
 */
export interface ServiceToken<T> {
  /** Developer-facing label used in error messages only. */
  readonly name: string;
  /** Phantom type slot; never present at runtime. */
  readonly [serviceTokenBrand]: T;
}

/**
 * Create a new service token. Each call produces a distinct identity even when
 * `name` repeats; the name is a label for diagnostics, not a key.
 */
export function createServiceToken<T>(name: string): ServiceToken<T> {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('service token name must be a non-empty string');
  }
  return { name } as unknown as ServiceToken<T>;
}

/** Machine-readable failure reason for {@link ServiceRegistryError}. */
export type ServiceRegistryErrorCode = 'duplicate' | 'not_found' | 'sealed' | 'closed';

/**
 * Raised for every registry invariant: a missing lookup, a duplicate
 * `provide`, or an attempt to register after sealing/closing. Messages carry
 * the token label, never the service value.
 */
export class ServiceRegistryError extends Error {
  readonly code: ServiceRegistryErrorCode;
  readonly tokenName: string | undefined;

  constructor(code: ServiceRegistryErrorCode, tokenName: string | undefined, message: string) {
    super(message);
    this.name = 'ServiceRegistryError';
    this.code = code;
    this.tokenName = tokenName;
  }
}

/** Read-only view of a service registry. */
export interface ServiceRegistry {
  /** Whether `token` currently resolves. Throws once the registry is closed. */
  has<T>(token: ServiceToken<T>): boolean;
  /** Resolve `token`, or `undefined` when absent. Throws once closed. */
  tryGet<T>(token: ServiceToken<T>): T | undefined;
  /** Resolve `token`, or throw `ServiceRegistryError` when absent/closed. */
  get<T>(token: ServiceToken<T>): T;
}

/** A read registry that can also register services. */
export interface ServiceRegistrar extends ServiceRegistry {
  /**
   * Register `value` under `token`. Rejects a second registration of the same
   * token (identity, not name) and any attempt after seal or clear.
   */
  provide<T>(token: ServiceToken<T>, value: T): void;
}

/** Owner-facing controller over one registry; the runner drives seal/clear. */
export interface ServiceRegistryController {
  /** Read-only view handed to extension consumers. */
  readonly services: ServiceRegistry;
  /** Write view handed to extension setup. */
  readonly registrar: ServiceRegistrar;
  /** Stop future `provide` calls; reads keep working. */
  seal(): void;
  /** Drop all services and close the registry so reads fail. */
  clear(): void;
}

function closedError(token: ServiceToken<unknown>): ServiceRegistryError {
  return new ServiceRegistryError('closed', token.name, 'service registry is closed');
}

/**
 * Create an isolated service registry. Every call owns its own map: there is
 * no global registry and no cross-app sharing.
 */
export function createServiceRegistry(): ServiceRegistryController {
  const values = new Map<ServiceToken<unknown>, unknown>();
  let sealed = false;
  let closed = false;

  const has = <T>(token: ServiceToken<T>): boolean => {
    if (closed) throw closedError(token);
    return values.has(token);
  };

  const tryGet = <T>(token: ServiceToken<T>): T | undefined => {
    if (closed) throw closedError(token);
    return values.get(token) as T | undefined;
  };

  const get = <T>(token: ServiceToken<T>): T => {
    if (closed) throw closedError(token);
    if (!values.has(token)) {
      throw new ServiceRegistryError(
        'not_found',
        token.name,
        `no service registered for token "${token.name}"`,
      );
    }
    return values.get(token) as T;
  };

  const provide = <T>(token: ServiceToken<T>, value: T): void => {
    if (closed) throw closedError(token);
    if (sealed) {
      throw new ServiceRegistryError(
        'sealed',
        token.name,
        `service registry is sealed; cannot provide "${token.name}"`,
      );
    }
    if (values.has(token)) {
      throw new ServiceRegistryError(
        'duplicate',
        token.name,
        `service token "${token.name}" is already provided`,
      );
    }
    values.set(token, value);
  };

  return {
    services: { has, tryGet, get },
    registrar: { has, tryGet, get, provide },
    seal(): void {
      sealed = true;
    },
    clear(): void {
      values.clear();
      sealed = true;
      closed = true;
    },
  };
}
