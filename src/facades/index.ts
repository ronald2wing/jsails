/**
 * Facades entry point.
 *
 * Server-only: the ambient application scope is an `AsyncLocalStorage`
 * (`node:async_hooks`), so this subpath is deliberately **not** in the
 * browser-safe set. The keys and tokens it resolves against live in
 * `jsails/extensions`, which stays browser-safe.
 *
 * Error convention: failures are raised as {@link FacadeError} with a
 * value-free message — it names the token label only, never a service value or
 * the resolved instance.
 */

export { currentAppScope, withAppScope, type AppScope } from './app-scope.js';

export { facade, installFacades, FacadeError, type FacadeErrorCode } from './facade.js';
