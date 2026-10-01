/**
 * Ambient application scope over the service registry.
 *
 * A facade (`facade(token)`) must resolve to *this* application's service without
 * a global instance slot. The framework already solves the same problem for
 * nested transactions with an {@link AsyncLocalStorage} map keyed by data-source
 * identity (`src/database/transaction.ts`); this module generalizes that pattern
 * to the whole application.
 *
 * The scope is opened once per unit of work — extension setup, a request, a
 * static-export render, a job handler — and holds the application's **live**
 * registry, not a snapshot: `runExtensions` populates the registry while the
 * setup scope is already open, so a copy would miss late `provide` calls.
 *
 * Nested scopes shadow outer ones (LIFO), which is what lets a job that runs
 * inside a request resolve facades against the job's own registry without
 * disturbing the request scope.
 *
 * No keying is needed: unlike transactions, there is a single ambient
 * application at a time on the async call path. An application that runs code
 * for a *different* application opens a fresh scope for that work.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { ServiceRegistry } from '../extensions/services.js';

/** The active application scope: the registry facades resolve against. */
export interface AppScope {
  readonly services: ServiceRegistry;
}

const als = new AsyncLocalStorage<AppScope>();

/**
 * Run `fn` with `services` as the ambient application scope. The scope is active
 * for the synchronous body and every async continuation it awaits, and is
 * restored on return/throw. Nested calls shadow the outer scope.
 */
export function withAppScope<T>(services: ServiceRegistry, fn: () => T): T {
  return als.run({ services }, fn);
}

/**
 * The active application scope, or `undefined` when no application work is in
 * progress (a top-level CLI script, pre-app code). Facades use the scoped form
 * there instead of the ambient one.
 */
export function currentAppScope(): AppScope | undefined {
  return als.getStore();
}
