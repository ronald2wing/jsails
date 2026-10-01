/**
 * Provenance-scoped autoload resolution.
 *
 * A plugin's symbols become bare `globalThis` names only when the participant
 * that *directly installed* it opts them in. This module computes, from an
 * install graph plus each plugin's {@link AutoloadDeclaration}, which plugins are
 * **active** — i.e. whose own autoload declaration actually applies.
 *
 * The rule (see the plan `2026-10-16-plugin-autoload-provenance.md`):
 *
 * - A plugin installed **directly** by the app/framework is active: its own
 *   `autoload` applies. Direct always wins.
 * - A plugin installed **transitively** by a meta plugin is active only if its
 *   installer *delegates* it (names it in `autoload.plugins`, or `autoload: all`
 *   delegates every installed plugin). A plugin installed but not delegated is
 *   **suppressed** — the installer uses its tools without exposing them.
 * - Delegation is not transitive: exposing plugin B does not expose B's own
 *   dependencies; B must itself delegate them (via B's own active `autoload`).
 *
 * The result is the set of active plugin ids; each active plugin's own
 * {@link AutoloadDeclaration} is then applied by the projection consumer.
 * Deterministic and frozen.
 */

import type { AutoloadDeclaration } from './framework-symbols.js';

/** One installed plugin: its identity, its autoload, and the plugins it installs. */
export interface InstalledPlugin {
  /** Plugin id matching the manifest id domain. */
  readonly id: string;
  /** Its own autoload declaration (absent ⇒ `none`). */
  readonly autoload?: AutoloadDeclaration;
  /** Plugin ids this plugin directly installs (its plugin dependencies). */
  readonly installs?: readonly string[];
}

/** Inputs to {@link resolveAutoloadExposure}. */
export interface ResolveAutoloadExposureInput {
  /** Plugin ids the app/framework installed directly (e.g. `plugins.use`). */
  readonly direct: readonly string[];
  /** Every installed plugin by id (direct and transitive). */
  readonly plugins: ReadonlyMap<string, InstalledPlugin>;
}

/**
 * Which installed plugin ids a plugin delegates (exposes) under its own
 * declaration: every `installs` id when `all`, or the named `plugins` when
 * `selected`. `none`/absent delegates nothing.
 */
function delegatedIds(plugin: InstalledPlugin): ReadonlySet<string> {
  const declaration = plugin.autoload;
  if (declaration === undefined || declaration.mode === 'none') {
    return new Set();
  }
  const installs = plugin.installs ?? [];
  if (declaration.mode === 'all') {
    return new Set(installs);
  }
  // `selected`: delegate only the named plugins that are actually installed.
  const named = new Set(declaration.plugins ?? []);
  return new Set(installs.filter((id) => named.has(id)));
}

/**
 * Compute the active plugin set. See the module doc for the exact precedence
 * and delegation rules. Deterministic and frozen.
 */
export function resolveAutoloadExposure(input: ResolveAutoloadExposureInput): ReadonlySet<string> {
  const active = new Set<string>();

  // Every directly-installed plugin is active.
  for (const id of input.direct) {
    if (input.plugins.has(id)) {
      active.add(id);
    }
  }

  // Walk every plugin's declared delegates: an installer delegating a plugin
  // makes that plugin active. A diamond is resolved by union — any installer
  // delegating a plugin exposes it (direct install always wins).
  const visit = (id: string): void => {
    const plugin = input.plugins.get(id);
    if (plugin === undefined) {
      return;
    }
    for (const dep of delegatedIds(plugin)) {
      if (input.plugins.has(dep)) {
        active.add(dep);
        visit(dep);
      }
    }
  };
  for (const id of input.plugins.keys()) {
    visit(id);
  }

  return Object.freeze(new Set([...active].sort()));
}
