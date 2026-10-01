/**
 * Shared structural validation for extension and module entries.
 *
 * Both the extension runner (`runExtensions`) and the app-config resolver
 * (`resolveExtensions`) must reject the same malformed entries before any setup
 * runs or any side effect occurs. This module centralizes that shape check so
 * the two callers stay in lock-step; each caller maps the returned error code to
 * its own error class and message — the runner echoes the entry name in a
 * `TypeError`, the config resolver keeps every message value-free.
 */

/** Machine-readable reason an extension/module entry was rejected. */
export type ExtensionEntryErrorCode =
  | 'not_object'
  | 'missing_name'
  | 'invalid_priority'
  | 'invalid_disabled'
  | 'duplicate_name'
  | 'missing_setup'
  | 'requires_not_array'
  | 'invalid_token'
  | 'provides_not_array'
  | 'invalid_provides_entry'
  | 'invalid_provides_override'
  | 'invalid_requires_union';

/** The first structural problem found in an entry list, or none when valid. */
export interface ExtensionEntryError {
  readonly code: ExtensionEntryErrorCode;
  /** 0-based index of the offending entry. */
  readonly index: number;
  /** The entry's name, when it is known at the point the error was detected. */
  readonly name: string | undefined;
}

/** The fields the shared check reads; callers cast the broader entry type. */
interface EntryLike {
  readonly name?: unknown;
  readonly priority?: unknown;
  readonly disabled?: unknown;
  readonly setup?: unknown;
  readonly requires?: unknown;
  readonly provides?: unknown;
}

function isObject(value: unknown): value is EntryLike {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A service-token-shaped object: an object with a non-empty string `name`. */
function isTokenLike(token: unknown): boolean {
  if (token === null || typeof token !== 'object' || Array.isArray(token)) return false;
  const name: unknown = (token as { name?: unknown }).name;
  return typeof name === 'string' && name.trim() !== '';
}

/**
 * Validate a list of extension/module entries, returning the first structural
 * error (or `undefined` when every entry is well-formed). Validation is
 * side-effect free: nothing is invoked and no entry value is echoed. Callers
 * decide how to surface the error.
 */
export function validateExtensionEntries(
  entries: readonly unknown[],
): ExtensionEntryError | undefined {
  const names = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isObject(entry)) {
      return { code: 'not_object', index, name: undefined };
    }
    const name = entry.name;
    if (typeof name !== 'string' || name.trim() === '') {
      return { code: 'missing_name', index, name: undefined };
    }
    const priority = entry.priority;
    if (priority !== undefined && (typeof priority !== 'number' || !Number.isFinite(priority))) {
      return { code: 'invalid_priority', index, name };
    }
    const disabled = entry.disabled;
    if (disabled !== undefined && typeof disabled !== 'boolean') {
      return { code: 'invalid_disabled', index, name };
    }
    if (names.has(name)) {
      return { code: 'duplicate_name', index, name };
    }
    names.add(name);
    if (typeof entry.setup !== 'function') {
      return { code: 'missing_setup', index, name };
    }
    const requires = entry.requires;
    if (requires !== undefined) {
      if (!Array.isArray(requires)) {
        return { code: 'requires_not_array', index, name };
      }
      for (const token of requires) {
        if (!isTokenLike(token)) {
          return { code: 'invalid_token', index, name };
        }
      }
    }
    const provides = entry.provides;
    if (provides !== undefined) {
      if (!Array.isArray(provides)) {
        return { code: 'provides_not_array', index, name };
      }
      for (const entry_ of provides) {
        if (entry_ === null || typeof entry_ !== 'object' || Array.isArray(entry_)) {
          return { code: 'invalid_provides_entry', index, name };
        }
        const provideEntry = entry_ as { contract?: unknown; override?: unknown };
        if (!isTokenLike(provideEntry.contract)) {
          return { code: 'invalid_provides_entry', index, name };
        }
        if (provideEntry.override !== undefined && typeof provideEntry.override !== 'boolean') {
          return { code: 'invalid_provides_override', index, name };
        }
      }
    }
  }
  return undefined;
}
