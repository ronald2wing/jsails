/**
 * The JSails server-component registry: the runtime seam between
 * compiler-emitted component registration and {@link serverComponentsPlugin}.
 *
 * A server component is a module that default-exports a
 * {@link ServerComponentDefinition}. The compiler discovers every module under
 * the root `components/` directory and emits a registration call —
 * {@link registerComponent} — that records the definition here. The
 * server-components plugin harvests the registry when it is built with no
 * explicit `components` map, so an app never lists its components by hand.
 *
 * The registry is **module-level and deterministic**: entries are keyed by the
 * component name and returned in registration order, so two applications in the
 * same process see the same components in the same order. It is
 * **test-reset-safe**: {@link clearComponentRegistry} empties it, and
 * {@link registerComponent} is idempotent for a given name (re-registering
 * replaces the prior entry in place, keeping its original position) so a
 * re-imported module never duplicates a component.
 *
 * This module is server-only — it is reached only through the server-components
 * extension, never a browser-safe entry.
 */

import type { ServerComponentDefinition } from './component.js';

/** Registration order is the harvest order; a Map preserves insertion order. */
const registry = new Map<string, ServerComponentDefinition<any>>();

/**
 * Register a server component definition.
 *
 * Idempotent per name: re-registering the same name replaces its entry in place
 * (preserving its original position) rather than appending a duplicate. This
 * keeps a re-imported module from double-registering a component while
 * preserving deterministic order.
 */
export function registerComponent(component: ServerComponentDefinition<any>): void {
  registry.set(component.name, component);
}

/**
 * The registered components keyed by name, in registration order. Returns a
 * frozen plain object so a caller cannot mutate the registry through the
 * returned map.
 */
export function registeredComponents(): Readonly<Record<string, ServerComponentDefinition<any>>> {
  return Object.freeze(Object.fromEntries(registry));
}

/**
 * Empty the registry. Intended for test isolation — a test that registers
 * components resets the registry in a teardown so the next test starts clean.
 */
export function clearComponentRegistry(): void {
  registry.clear();
}
