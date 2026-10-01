/**
 * Pure projection engine for the framework-symbol globals — the node-free half
 * of the installer.
 *
 * Split out of `install-server.ts` so the **browser** projection can
 * reuse it without dragging in `node:fs`/`node:path`/`node:url` (the server
 * installer's file I/O lives only in that module). Everything here is
 * environment-agnostic: it takes `globalThis` as the target and an
 * already-loaded `specifier → module namespace` map, so the caller decides *how*
 * modules are obtained (a dynamic `import()` on the server; a Vite-processed
 * dynamic `import()` in the browser).
 *
 * **Why the projection rules live in one place.** The server and browser
 * projections must agree on collision handling, namespace objects, override
 * warnings, and the missing-symbol throw — a divergence would make a name behave
 * differently per target with no signal. One engine, two thin loaders.
 *
 * **Shared provenance across both projections.** {@link installedFrameworkSymbolOrigins} is a
 * module-level map keyed by bare name: whether a slot was filled by the server
 * projection or the browser projection, the record is the same, so a later
 * projection in the same process names what it overrides correctly.
 */

import type { FrameworkSymbol } from './framework-symbols.js';
import {
  computeFrameworkSymbolCollisionGroups,
  deriveFrameworkSymbolNamespaceKeys,
} from './framework-symbols.js';

/**
 * Where an installed global came from, as a stable diagnostic label:
 *
 * - `framework:<specifier>` — a framework global from that subpath's barrel
 *   (`framework:jsails/api`).
 * - `plugin:<name>` — a symbol contributed by a named plugin descriptor.
 * - `namespace:<key>` — a collision namespace object derived by this installer
 *   (`namespace:content`); synthetic, never a real subpath.
 * - `pre-existing (unknown)` — a value already on `globalThis` that no JSails
 *   projection put there (app code, another package, a host runtime global such
 *   as Node's `require`).
 */
export type FrameworkSymbolOrigin =
  `framework:${string}` | `plugin:${string}` | `namespace:${string}` | 'pre-existing (unknown)';

/** A projection that replaced an existing `globalThis` value. */
export interface FrameworkSymbolOverrideWarning {
  /** The bare global name that changed. */
  readonly name: string;
  /** Origin of the value that was there before. */
  readonly from: FrameworkSymbolOrigin;
  /** Origin of the value that replaced it. */
  readonly over: FrameworkSymbolOrigin;
  /** Stable machine-readable discriminator. */
  readonly reason: 'override';
}

/**
 * Origin of every name a JSails projection has published, persisted across
 * calls and shared by the server and browser projections. `globalThis` carries
 * no provenance of its own; this map is the only record that a value at a bare
 * slot came from a framework or plugin projection rather than from the host.
 *
 * A name absent from the map whose slot is nonetheless occupied is
 * `pre-existing (unknown)`.
 */
const installedFrameworkSymbolOrigins = new Map<string, FrameworkSymbolOrigin>();

/** Options for {@link projectFrameworkSymbols}. */
export interface ProjectFrameworkSymbolsOptions {
  /** The table of globals to project. */
  readonly globals: readonly FrameworkSymbol[];
  /**
   * Already-loaded module namespaces, keyed by the exact specifier string each
   * entry's `specifier` field carries. Every distinct specifier in `globals`
   * must be present.
   */
  readonly modules: ReadonlyMap<string, Record<string, unknown>>;
  /** Sink for override warnings; absent ⇒ {@link defaultWarn} (`console.warn`). */
  readonly onWarn?: (warning: FrameworkSymbolOverrideWarning) => void;
  /**
   * Origin label applied to every entry instead of `framework:<specifier>`,
   * used by a plugin projection that shares this engine.
   */
  readonly origin?: FrameworkSymbolOrigin;
}

/**
 * Project every entry of `globals` onto `globalThis` from the pre-loaded
 * `modules` map.
 *
 * When every declared name is unique, only bare names are installed. When a name
 * collides (more than one entry declares it), the first entry in table order
 * wins the bare slot and a **namespace object** is installed for each distinct
 * subpath whose symbols collide, keyed by a segment derived from the subpath
 * (e.g. `globalThis.content = { readingTime, ... }`), so the losing provider's
 * symbol stays reachable by property access.
 *
 * **Override policy.** A bare name whose slot already holds a *different* value
 * is replaced, but first a {@link FrameworkSymbolOverrideWarning} is emitted naming what
 * was lost (`from`) and what won (`over`). An identical re-install is silent, so
 * the call is idempotent without noise. This function never throws on an
 * override and never suppresses one — a later projection wins, transparently.
 *
 * Throws a value-free error when a declared symbol is missing from its loaded
 * module — that is a framework bug, not a user error, and must fail loudly
 * rather than leave a bare name unresolved.
 */
export function projectFrameworkSymbols(options: ProjectFrameworkSymbolsOptions): void {
  const { globals, modules, origin: originOverride } = options;
  const onWarn = options.onWarn ?? defaultWarn;

  const target = globalThis as Record<string, unknown>;

  const originOf = (specifier: string): FrameworkSymbolOrigin =>
    originOverride ?? `framework:${specifier}`;

  /**
   * Assign a bare name, warning when it displaces a different prior value.
   *
   * `notOverridable` names (namespace objects, whose identity is derived
   * deterministically from the table) keep their prior object when this
   * projection already owns the slot, so an idempotent re-install preserves the
   * object identity the collision tests rely on.
   */
  const projectBare = (
    name: string,
    value: unknown,
    origin: FrameworkSymbolOrigin,
    notOverridable = false,
  ): void => {
    const existing = target[name];
    const priorOrigin = installedFrameworkSymbolOrigins.get(name);
    if (notOverridable && priorOrigin !== undefined && existing !== undefined) {
      // We own this derived slot; the freshly derived value is equivalent, so
      // leave the installed object in place (stable identity, no warning).
      return;
    }
    const changed = existing !== value;
    // Warn only when a real override happens: the slot held a different value.
    // `existing === undefined` with no recorded origin means the slot was empty,
    // which is not an override.
    if (changed && (existing !== undefined || priorOrigin !== undefined)) {
      onWarn({
        name,
        from: priorOrigin ?? 'pre-existing (unknown)',
        over: origin,
        reason: 'override',
      });
    }
    target[name] = value;
    installedFrameworkSymbolOrigins.set(name, origin);
  };

  // --- Collision analysis ---
  const collisions = computeFrameworkSymbolCollisionGroups(globals);
  const collidingNames = new Set(collisions.keys());

  // Collect every specifier that participates in at least one collision, so we
  // can derive namespace keys only for those that need them.
  const collidingSpecifiers = new Set<string>();
  for (const entries of collisions.values()) {
    for (const entry of entries) {
      collidingSpecifiers.add(entry.specifier);
    }
  }
  const namespaceKeys = deriveFrameworkSymbolNamespaceKeys(collidingSpecifiers);

  // Namespace objects under construction (key → object).
  const namespaceObjects = new Map<string, Record<string, unknown>>();

  // Bare names assigned during THIS call. Distinguishes "a later colliding entry
  // lost to the first-in-order winner" from "a pre-existing global owns the
  // slot" — a prior `name in target` check conflated the two.
  const assignedBare = new Set<string>();

  // --- Install bare names ---
  for (const { name, specifier } of globals) {
    const module = modules.get(specifier);
    const value = module?.[name];
    if (value === undefined) {
      throw new Error(`framework global "${name}" is not exported by "${specifier}"`);
    }

    // Colliding names: the first entry in table order wins the bare slot; a
    // later entry for the same name never touches the bare slot (it is reachable
    // only through its namespace object).
    const isBareWinner = !collidingNames.has(name) || !assignedBare.has(name);
    if (isBareWinner) {
      projectBare(name, value, originOf(specifier));
      assignedBare.add(name);
    }

    // Park colliding entries in their namespace object.
    if (collidingSpecifiers.has(specifier)) {
      const key = namespaceKeys.get(specifier);
      if (key !== undefined) {
        let ns = namespaceObjects.get(key);
        if (!ns) {
          ns = {};
          namespaceObjects.set(key, ns);
        }
        ns[name] = value;
      }
    }
  }

  // --- Install namespace objects ---
  // Reachable only by property access; a prior namespace object this projection
  // owns is left in place so idempotent re-installs preserve identity.
  for (const [key, ns] of namespaceObjects) {
    projectBare(key, ns, `namespace:${key}`, true);
  }
}

/** Default warning sink: a single `console.warn` line per override. */
function defaultWarn(warning: FrameworkSymbolOverrideWarning): void {
  console.warn(
    `jsails: global "${warning.name}" overridden — ${warning.over} replaced ${warning.from}`,
  );
}

/** Every distinct specifier referenced by `globals`, sorted deterministically. */
export function distinctFrameworkSymbolSpecifiers(
  globals: readonly FrameworkSymbol[],
): readonly string[] {
  return [...new Set(globals.map((entry) => entry.specifier))].sort();
}
