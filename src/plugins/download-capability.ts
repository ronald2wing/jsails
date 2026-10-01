/**
 * Plugin download capability resolution.
 *
 * A plugin installer's ability to download artifacts depends on both static
 * configuration and the runtime mode it is operating in. `resolveDownloadsCapability`
 * folds those inputs into a single, exhaustive decision:
 *
 * - A static export is always read-only: downloads are disabled regardless of
 *   configuration, because no network or filesystem side effects may happen
 *   during export.
 * - An explicit `configured: false` disables downloads.
 * - Everything else (`true`, `undefined`, or `null`) enables them.
 *
 * The result is `{ enabled, reason? }`: when disabled, `reason` is a stable,
 * value-free message the caller can surface or log.
 */

/** Inputs to {@link resolveDownloadsCapability}. */
export interface ResolveDownloadsCapabilityInput {
  /** The caller's static download setting; `false` disables, `true`/`undefined`/`null` enable. */
  readonly configured?: boolean | null;
  /** Whether the current mode is a static export (always read-only). */
  readonly staticExport: boolean;
}

/** The resolved capability decision. */
export interface DownloadsCapability {
  /** Whether downloads are permitted. */
  readonly enabled: boolean;
  /** Stable, value-free reason when downloads are disabled. */
  readonly reason?: string;
}

/** Fold configuration and mode into a single download-capability decision. */
export function resolveDownloadsCapability(
  input: ResolveDownloadsCapabilityInput,
): DownloadsCapability {
  if (input.staticExport) {
    return {
      enabled: false,
      reason: 'downloads are unavailable during static export',
    };
  }
  if (input.configured === false) {
    return {
      enabled: false,
      reason: 'downloads are disabled by configuration',
    };
  }
  return { enabled: true };
}
