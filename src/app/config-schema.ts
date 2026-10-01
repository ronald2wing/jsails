/**
 * Opt-in typed app-config helper: validate an application config object against
 * a Zod schema and return the typed result with value-free errors.
 *
 * This is additive and never changes runtime loader behaviour — it composes
 * with {@link validateAppConfig} from the config barrel:
 *
 * - `defineAppConfig` validates SHAPE (rejects unknown keys, mistyped fields).
 * - `validateAppConfig` resolves paths (makes directories absolute).
 *
 * The error shape mirrors {@link readEnvironment}/{@link EnvironmentError}:
 * a {@link AppConfigError} carrying `{ path, code, message }[]` with no raw
 * input values. The built-in {@link appConfigSchema} is re-exported so a user
 * can do `defineAppConfig(appConfigSchema, { port: 3000 })` for immediate
 * type-checking; pass any `z.ZodType` to extend or override it.
 */

import type { z } from 'zod';

import { mapZodIssues, type ZodIssueEntry } from '../internal/zod.js';
import { AppConfigError, appConfigSchema, type ConfigSchemaIssue } from './config/schema.js';

export { appConfigSchema };
export { AppConfigError, type ConfigSchemaIssue } from './config/schema.js';

/** Convert the canonical issue-entry path to a structured path array. */
function toConfigSchemaIssue(entry: ZodIssueEntry): ConfigSchemaIssue {
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
 * Validate a user's app-config object against a Zod schema.
 *
 * An {@link appConfigSchema} re-export is available for immediate use.
 * Extend it with `.extend()` or supply a custom `z.ZodType` to validate
 * additional keys. Unknown keys are rejected when the schema is `.strict()`
 * (which {@link appConfigSchema} is); this is the recommended default so a
 * top-level typo fails fast rather than silently.
 *
 * On success the typed config object is returned; the input is never mutated.
 * On failure a value-free {@link AppConfigError} is thrown carrying structured
 * `{ path, code, message }[]` issues — input values are never echoed.
 *
 * This function is PURE: it performs no I/O and never calls any callback.
 */
export function defineAppConfig<S extends z.ZodTypeAny>(schema: S, config: z.infer<S>): z.infer<S> {
  try {
    const result = schema.safeParse(config);
    if (result.success) {
      return result.data;
    }
    const issues = mapZodIssues(result.error).map(toConfigSchemaIssue);
    throw new AppConfigError(issues.map(formatConfigIssue).join('; '), issues);
  } catch (error) {
    if (error instanceof AppConfigError) {
      throw error;
    }
    // A throwing transform/refine — replace with a value-free generic error.
    throw new AppConfigError('app config validation failed');
  }
}

function formatConfigIssue(issue: ConfigSchemaIssue): string {
  const location = issue.path.length > 0 ? `config.${issue.path.join('.')}` : 'the app config';
  return `${location}: ${issue.message}`;
}
