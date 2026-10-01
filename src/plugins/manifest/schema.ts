/**
 * Plugin manifest contract: the JSON shape a plugin package or bundle declares
 * so the framework can discover, check, and (later) activate it without
 * importing any plugin code.
 *
 * A manifest is a plain JSON object validated with Zod and then checked for
 * semver soundness. `parsePluginManifest` returns the parsed value or throws a
 * {@link PluginManifestError} whose messages are value-free: invalid input,
 * credentials, and arbitrary content are never echoed. The manifest describes
 * the plugin (`id`, `version`, `jsailsCompat`, declared `permissions`, declared
 * plugin-to-plugin `plugins`, an opaque `settingsSchema`, the `entry`
 * module/path) and its integrity envelope (`checksums`, `signature`); every
 * field is carried through verbatim for a later slice to consume. This module
 * only reads and validates. Version/range grammar lives in `semver.ts`; the
 * npm `package.json` `jsails` field alias lives in `package-field.ts`.
 */

import { z } from 'zod';

import { mapZodIssues, type ZodIssueEntry } from '../../internal/zod.js';
import { isValidSemverRange, isValidSemverVersion } from './semver.js';

// ---------------------------------------------------------------------------
// Patterns and bounds
// ---------------------------------------------------------------------------

/**
 * Plugin identifiers: a lowercase/digit start followed by lowercase letters,
 * digits, `.`, `_`, or `-`. Matches the `id` uniqueness domain and doubles as
 * the key used for cross-source dedupe and the `disabled` opt-out list.
 */
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** A declared permission: dotted lowercase identifier segments. */
export const PERMISSION_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*$/;

/** The manifest filename a bundle carries inside its directory. */
export const PLUGIN_MANIFEST_FILENAME = 'manifest.json';

/** Upper bound on declared permissions (defends against pathological input). */
const MAX_PERMISSIONS = 100;
/** Upper bound on declared plugin dependencies. */
const MAX_PLUGIN_DEPENDENCIES = 100;
/** Upper bound on checksum entries. */
const MAX_CHECKSUMS = 1000;
/** Upper bound on the manifest id length. */
const MAX_ID_LENGTH = 214;
/** Upper bound on a version/range string length. */
const MAX_VERSION_LENGTH = 256;
/** Upper bound on an entry specifier/path length. */
const MAX_ENTRY_LENGTH = 1024;

// ---------------------------------------------------------------------------
// Typed manifest and its error
// ---------------------------------------------------------------------------

/** A declared plugin-to-plugin dependency: another plugin id plus a version range. */
export interface PluginDependency {
  /** Required plugin id matching {@link PLUGIN_ID_PATTERN}. */
  readonly id: string;
  /** Semver range the required plugin's version must satisfy. */
  readonly range: string;
}

/** A validated plugin manifest. */
export interface PluginManifest {
  /** Unique plugin id matching {@link PLUGIN_ID_PATTERN}. */
  readonly id: string;
  /** Plugin version (valid semver). */
  readonly version: string;
  /** Semver range of framework versions this plugin supports. */
  readonly jsailsCompat: string;
  /** Declared permissions (dotted identifiers). Defaults to `[]`. */
  readonly permissions: readonly string[];
  /** Declared plugin-to-plugin dependencies, unique by id. Defaults to `[]`. */
  readonly plugins?: readonly PluginDependency[];
  /** Opaque settings schema (a JSON object when present); never interpreted here. */
  readonly settingsSchema?: Readonly<Record<string, unknown>>;
  /** Entry module specifier (npm) or relative path (bundle). */
  readonly entry: string;
  /** Path -> checksum map carried through verbatim. */
  readonly checksums?: Readonly<Record<string, string>>;
  /** Manifest signature carried through verbatim. */
  readonly signature?: string;
}

/** A value-free validation failure: a field path plus a stable code. */
export interface PluginManifestIssue {
  /** Location of the failure, e.g. `["id"]`. Never a raw value. */
  readonly path: readonly (string | number)[];
  /** Stable machine code, e.g. `"required"`, `"invalid_format"`, `"invalid_version"`. */
  readonly code: string;
  /** Short description derived only from the schema, never from input. */
  readonly message: string;
}

/** Raised when a manifest fails shape or semver validation. */
export class PluginManifestError extends Error {
  /** Structured, value-free failures. Never contains raw input values. */
  readonly issues: readonly PluginManifestIssue[];

  constructor(issues: readonly PluginManifestIssue[]) {
    super(issues.map(formatIssue).join('; '));
    this.name = 'PluginManifestError';
    this.issues = issues;
  }
}

function formatIssue(issue: PluginManifestIssue): string {
  const location = issue.path.length > 0 ? issue.path.join('.') : '(manifest)';
  return `${location}: ${issue.message}`;
}

function issue(
  path: readonly (string | number)[],
  code: string,
  message: string,
): PluginManifestIssue {
  return { path, code, message };
}

function manifestError(path: readonly (string | number)[], code: string, message: string): never {
  throw new PluginManifestError([issue(path, code, message)]);
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/**
 * The manifest schema. Strict: unknown fields are rejected rather than ignored,
 * so a typo in an author's manifest surfaces instead of silently dropping
 * behavior. `permissions` and `plugins` default to `[]`; `settingsSchema`,
 * `checksums`, and `signature` are optional.
 */
export const pluginManifestSchema = z
  .object({
    id: z.string().min(1).max(MAX_ID_LENGTH).regex(PLUGIN_ID_PATTERN),
    version: z.string().min(1).max(MAX_VERSION_LENGTH),
    jsailsCompat: z.string().min(1).max(MAX_VERSION_LENGTH),
    permissions: z
      .array(z.string().min(1).regex(PERMISSION_PATTERN))
      .max(MAX_PERMISSIONS)
      .default([]),
    plugins: z
      .array(
        z
          .object({
            id: z.string().min(1).max(MAX_ID_LENGTH).regex(PLUGIN_ID_PATTERN),
            range: z.string().min(1).max(MAX_VERSION_LENGTH),
          })
          .strict(),
      )
      .max(MAX_PLUGIN_DEPENDENCIES)
      .default([]),
    settingsSchema: z.record(z.string(), z.unknown()).optional(),
    entry: z.string().min(1).max(MAX_ENTRY_LENGTH),
    checksums: z.record(z.string().min(1), z.string().min(1)).optional(),
    signature: z.string().min(1).optional(),
  })
  .strict();

/**
 * Translate a Zod failure into value-free {@link PluginManifestIssue}s via the
 * canonical mapper. The canonical path is a dotted string; we split it back
 * to a `(string | number)[]` so `PluginManifestIssue.path` stays an array for
 * format rendering.
 */
function mapManifestIssues(error: z.ZodError): PluginManifestIssue[] {
  return mapZodIssues(error).map(toManifestIssue);
}

function toManifestIssue(entry: ZodIssueEntry): PluginManifestIssue {
  return {
    path: entry.path === '_root' ? [] : splitDottedPath(entry.path),
    code: entry.code,
    message: entry.message,
  };
}

/** Split a canonical dotted path like `"plugins.0.id"` into `["plugins", 0, "id"]`. */
function splitDottedPath(dotted: string): readonly (string | number)[] {
  return dotted.split('.').map((seg) => {
    const n = Number(seg);
    return String(n) === seg && seg !== '' ? n : seg;
  });
}

/**
 * Validate and parse a raw manifest value. Throws a {@link PluginManifestError}
 * with value-free issues for a shape failure, a version that is not valid
 * semver, a `jsailsCompat` range that does not parse, a plugin dependency
 * `range` that does not parse, or a plugin dependency id repeated within
 * `plugins`. The raw input is never echoed and never mutated.
 */
export function parsePluginManifest(raw: unknown): PluginManifest {
  const result = pluginManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new PluginManifestError(mapManifestIssues(result.error));
  }
  const data = result.data;
  if (!isValidSemverVersion(data.version)) {
    manifestError(['version'], 'invalid_version', 'must be a valid semver version');
  }
  if (!isValidSemverRange(data.jsailsCompat)) {
    manifestError(['jsailsCompat'], 'invalid_range', 'must be a valid semver range');
  }
  if (data.checksums !== undefined && Object.keys(data.checksums).length > MAX_CHECKSUMS) {
    manifestError(['checksums'], 'too_big', `must have at most ${MAX_CHECKSUMS} entries`);
  }
  const seen = new Set<string>();
  data.plugins.forEach((dependency, index) => {
    if (!isValidSemverRange(dependency.range)) {
      manifestError(['plugins', index, 'range'], 'invalid_range', 'must be a valid semver range');
    }
    if (seen.has(dependency.id)) {
      manifestError(['plugins', index, 'id'], 'duplicate_id', 'must be unique among plugins');
    }
    seen.add(dependency.id);
  });
  return data;
}
