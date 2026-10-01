/**
 * Clean-client-bundle enforcement: a server-only module must never reach the
 * browser bundle.
 *
 * The authoring model (Phase 2) separates client-safe component code from
 * server-only modules (e.g. `*.server.ts`). This module ships the pure check
 * plus a Rolldown/Vite `generateBundle` hook that fails the build when a
 * server-only module is bundled into a client chunk.
 *
 * The check is structural and value-free: it reasons only over chunk metadata
 * (fileName/type/moduleIds) and a caller-supplied `serverOnly` predicate, never
 * over file contents or the predicate's implementation. There is no runtime
 * dependency on Rolldown or Vite — the returned plugin object is structurally
 * compatible with either bundler's `generateBundle` hook.
 */

/**
 * Structural shape of a Rolldown/Vite output chunk (or asset). `type` is
 * optional so a non-chunk asset (`type: 'asset'`) is distinguishable but still
 * accepted; `moduleIds` is present only on chunks, hence optional.
 */
export interface ClientBundleChunk {
  readonly fileName: string;
  readonly type?: string;
  readonly moduleIds?: readonly string[];
}

/**
 * A single offending server-only module and the import chain that reached it.
 * `serverOnlyModule` is the offender; `chain` runs from the client entry to the
 * offender (entry first, offender last). Best-effort: when parent information
 * is unavailable the chain is just `[serverOnlyModule]`.
 */
export interface CleanBundleViolation {
  readonly serverOnlyModule: string;
  readonly chain: readonly string[];
}

/** Format one violation into the default `CleanBundleError` message line. */
function formatViolation(violation: CleanBundleViolation): string {
  return (
    `server-only module reached the client bundle: ${violation.serverOnlyModule}` +
    ` (chain: ${violation.chain.join(' -> ')})`
  );
}

/** Format every violation, one line each, into the default error message. */
function formatViolations(violations: readonly CleanBundleViolation[]): string {
  return violations.map(formatViolation).join('\n');
}

/**
 * Find every server-only module present in `bundle`. Pure and deterministic:
 * chunks (`type === 'chunk'` or `type` undefined) are scanned, assets are
 * ignored, duplicates across chunks collapse to one violation per module id,
 * and the result is sorted by module id. The predicate itself and file
 * contents are never included in the result.
 */
export function findServerOnlyModules(
  bundle: readonly ClientBundleChunk[],
  serverOnly: (id: string) => boolean,
): CleanBundleViolation[] {
  const violationsByModule = new Map<string, CleanBundleViolation>();

  for (const chunk of bundle) {
    // An asset carries no module ids; skip anything that is not a chunk.
    if (chunk.type !== undefined && chunk.type !== 'chunk') {
      continue;
    }
    for (const id of chunk.moduleIds ?? []) {
      if (serverOnly(id) && !violationsByModule.has(id)) {
        // Parent import info is not part of the structural chunk shape, so the
        // chain degrades to the offender alone until that data is available.
        violationsByModule.set(id, { serverOnlyModule: id, chain: [id] });
      }
    }
  }

  return [...violationsByModule.values()].sort((a, b) =>
    a.serverOnlyModule < b.serverOnlyModule ? -1 : a.serverOnlyModule > b.serverOnlyModule ? 1 : 0,
  );
}

/**
 * Raised when a server-only module reaches the client bundle. The default
 * message names each offending module and its import chain but never embeds
 * bundle code or absolute filesystem paths beyond the module ids themselves.
 */
export class CleanBundleError extends Error {
  readonly violations: readonly CleanBundleViolation[];

  constructor(violations: readonly CleanBundleViolation[], message?: string) {
    super(message ?? formatViolations(violations));
    this.name = 'CleanBundleError';
    this.violations = violations;
  }
}

/**
 * Throw a {@link CleanBundleError} when `bundle` contains a server-only module,
 * and return `void` otherwise. The predicate is the caller's definition of
 * "server-only"; this function only applies it to chunk module ids.
 */
export function assertCleanClientBundle(
  bundle: readonly ClientBundleChunk[],
  serverOnly: (id: string) => boolean,
): void {
  const violations = findServerOnlyModules(bundle, serverOnly);
  if (violations.length > 0) {
    throw new CleanBundleError(violations);
  }
}

/** Options accepted by {@link cleanBundlePlugin}. */
export interface CleanBundlePluginOptions {
  /** Predicate naming the server-only modules that must never be bundled. */
  readonly serverOnly: (id: string) => boolean;
}

/**
 * Minimal structural view of the bundler's `PluginContext` used only to walk
 * importer edges. `getModuleInfo` returns `null` for an unknown id; `importers`
 * lists the modules that import it. Both are optional so the plugin still works
 * when a context cannot supply them (the chain then degrades to the offender).
 */
interface ImporterContext {
  getModuleInfo?: (id: string) =>
    | {
        importers?: readonly string[];
      }
    | null
    | undefined;
}

/**
 * Reconstruct a best-effort import chain from a client entry down to
 * `serverOnlyModule`, following `importers` edges. The bundler's graph points
 * importer -> imported, so we walk *up* through importers and reverse the path
 * to read entry-first. A depth bound and a visited set make this safe against
 * cycles. When no context or importers are available the chain is just the
 * offender. Pure aside from the read-only `getModuleInfo` probe.
 */
function buildImportChain(context: unknown, serverOnlyModule: string): readonly string[] {
  const getModuleInfo = (context as ImporterContext | null)?.getModuleInfo;
  if (typeof getModuleInfo !== 'function') {
    return [serverOnlyModule];
  }

  const MAX_DEPTH = 64;
  // Walk upward: each step moves to a module that imports the current one. The
  // first module with no importers is the root (the client entry) — stop there.
  const upward: string[] = [serverOnlyModule];
  const seen = new Set<string>([serverOnlyModule]);
  let current = serverOnlyModule;

  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const info = getModuleInfo(current);
    const importers = info?.importers ?? [];
    // Prefer a deterministic parent; the chain is advisory, not a proof.
    const parent = [...importers].sort()[0];
    if (parent === undefined || seen.has(parent)) {
      break;
    }
    upward.push(parent);
    seen.add(parent);
    current = parent;
  }

  // `upward` runs offender -> ... -> entry; reverse it to read entry-first.
  return upward.reverse();
}

/**
 * Build a Rolldown/Vite-compatible plugin whose `generateBundle` hook fails the
 * build when a server-only module reaches a client chunk. Construction
 * validates that `serverOnly` is a function and throws a plain value-free
 * `Error` otherwise; no bundler code is imported or invoked.
 *
 * The hook names the offender and, when the bundler exposes importer metadata,
 * the import chain that reached it (entry first, offender last) so the failure
 * points at the offending `import` rather than only the bundled module id.
 */
export function cleanBundlePlugin(options: CleanBundlePluginOptions): {
  name: string;
  generateBundle(
    this: unknown,
    _outputOptions: unknown,
    bundle: Record<string, ClientBundleChunk>,
  ): void;
} {
  if (typeof options.serverOnly !== 'function') {
    throw new Error('cleanBundlePlugin requires a serverOnly predicate');
  }

  return {
    name: 'jsails-clean-client-bundle',
    generateBundle(_outputOptions, bundle) {
      const violations = findServerOnlyModules(Object.values(bundle), options.serverOnly);
      if (violations.length === 0) {
        return;
      }
      // `this` is the bundler's PluginContext in a real build; passed through
      // opaquely so the plugin stays bundler-agnostic, then viewed structurally
      // only to read importer edges. A context that cannot supply importers
      // degrades the chain to the bare offender.
      const chained = violations.map((violation) => ({
        serverOnlyModule: violation.serverOnlyModule,
        chain: buildImportChain(this, violation.serverOnlyModule),
      }));
      throw new CleanBundleError(chained);
    },
  };
}
