/**
 * Facades: name-resolved, scope-correct access to application services.
 *
 * A facade is a typed `Proxy` over a service type `T`. Every property access
 * resolves the service from the **ambient application scope**
 * ({@link currentAppScope}) by token identity and returns the member bound to the
 * real instance, so calls and chaining behave exactly as if the instance had
 * been injected — but the call site writes a stable name (`Cache.get('x')`) with
 * no `new` and no token.
 *
 * This is deliberately **not** a Laravel-style static facade bound to a global
 * instance slot. Resolution happens per call against the current scope, so the
 * same facade name resolves to the right application under any number of
 * concurrently-live applications, and errors cleanly once the scope ends instead
 * of returning a stale instance.
 *
 * Any author — framework or application — can make their own class a facade with
 * one line: `const Cache = facade(cacheToken, 'Cache')`. The `token` carries the
 * type; the `name` is a diagnostic label only.
 */

import { currentAppScope } from './app-scope.js';
import type { ServiceRegistry } from '../extensions/services.js';
import type { ServiceToken } from '../extensions/services.js';

/** Machine-readable failure reason for {@link FacadeError}. */
export type FacadeErrorCode = 'no_app_scope' | 'unresolved';

/**
 * Raised when a facade cannot resolve its service. Messages name the token
 * label only — never a service value, and never the resolved instance.
 */
export class FacadeError extends Error {
  readonly code: FacadeErrorCode;
  readonly tokenName: string;

  constructor(code: FacadeErrorCode, tokenName: string, message: string) {
    super(message);
    this.name = 'FacadeError';
    this.code = code;
    this.tokenName = tokenName;
  }
}

/** Resolve the ambient registry, or throw a value-free `no_app_scope`. */
function requireScope(tokenName: string): ServiceRegistry {
  const scope = currentAppScope();
  if (scope === undefined) {
    throw new FacadeError(
      'no_app_scope',
      tokenName,
      `facade "${tokenName}" was used outside an application scope; ` +
        'call it inside a request, setup, job, or resolve the token directly',
    );
  }
  return scope.services;
}

/**
 * Resolve `token` in the ambient scope. Missing providers throw a value-free
 * `unresolved` rather than returning `undefined`.
 */
function resolveService<T>(token: ServiceToken<T>): T {
  const registry = requireScope(token.name);
  if (!registry.has(token)) {
    throw new FacadeError(
      'unresolved',
      token.name,
      `facade "${token.name}" has no provider in the current application scope`,
    );
  }
  return registry.get(token);
}

/**
 * Make `token`'s service callable by name. The returned value is typed as `T`
 * but every property access forwards to the scope-resolved instance.
 *
 * A facade is a **token-addressed resolver**, so it is canonical per token: the
 * same `facade(token)` call returns the same proxy, which is what lets
 * {@link installFacades} stay idempotent when two applications (a test app and a
 * served app, say) install the same shared facade name.
 */
const proxies = new WeakMap<ServiceToken<unknown>, object>();

export function facade<T>(token: ServiceToken<T>): T {
  const cached = proxies.get(token);
  if (cached !== undefined) {
    return cached as T;
  }
  // The proxy target is an internal detail: the typed surface is `T`, and every
  // access forwards to the scope-resolved instance.
  const proxy = new Proxy(Object.create(null) as object, {
    get(_target, property): unknown {
      const service = resolveService(token);
      const value = (service as Record<PropertyKey, unknown>)[property];
      // Bind methods to the real instance so a detached reference still works;
      // chainable calls return the instance's own results unchanged.
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(service)
        : value;
    },
    has(_target, property): boolean {
      const service = resolveService(token);
      return property in (service as object);
    },
    ownKeys(): ArrayLike<string | symbol> {
      const service = resolveService(token);
      return Reflect.ownKeys(service as object);
    },
    getOwnPropertyDescriptor(_target, property): PropertyDescriptor | undefined {
      const service = resolveService(token);
      return Reflect.getOwnPropertyDescriptor(service as object, property);
    },
    set(_target, property, value): boolean {
      const service = resolveService(token);
      (service as Record<PropertyKey, unknown>)[property] = value;
      return true;
    },
  });
  proxies.set(token, proxy);
  return proxy as T;
}

/**
 * Publish facades as boot globals (opt-in). Each slot holds the **proxy**, not
 * an instance, so concurrent applications resolve correctly. Reinstalling the
 * same facade is a no-op; a name already held by a *different* global throws a
 * value-free `TypeError` rather than silently shadowing.
 */
export function installFacades(entries: Record<string, object>): void {
  const target = globalThis as Record<string, unknown>;
  for (const [name, value] of Object.entries(entries)) {
    const existing = target[name];
    if (existing !== undefined && existing !== value) {
      throw new TypeError(
        `global "${name}" is already defined and is not this facade; choose a distinct name`,
      );
    }
    target[name] = value;
  }
}
