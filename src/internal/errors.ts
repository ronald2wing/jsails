/**
 * Internal error helpers shared by the CLI dispatcher, the command modules,
 * Jamal, and the deploy tooling.
 *
 * Kept as a leaf module so command implementations never import back from
 * `cli.ts` (which would form an import cycle). Dependency-free (no Node
 * runtime imports), so it is also safe to import from browser modules. Nothing
 * here is re-exported from the package entry (`src/index.ts`).
 */

/** Options for the sanitized form of {@link formatError}. */
interface FormatErrorOptions {
  /** When set, only errors passing this predicate have their message echoed. */
  readonly allow?: (error: unknown) => boolean;
  /** Message returned when `allow` is set and the error is not allowed. */
  readonly fallback?: string;
}

/**
 * Render any thrown value as a single-line message. With `options.allow`, the
 * message is echoed only for errors the caller declares safe to surface; every
 * other value is replaced with `options.fallback` (default `the command failed`).
 */
export function formatError(error: unknown, options?: FormatErrorOptions): string {
  if (options?.allow !== undefined && !options.allow(error)) {
    return options.fallback ?? 'the command failed';
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** The errno `code` of a Node-style error, if any (e.g. `ENOENT`, `EACCES`). */
export function errnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
  }
  return undefined;
}

/** Whether `error` is a Node-style error carrying the given errno `code`. */
export function isErrno(error: unknown, code: string): boolean {
  return errnoCode(error) === code;
}

/**
 * Report a usage failure to `write` and return the exit code (2). `helpHint` is
 * the caller's command-specific help line, so the shared body stays identical
 * while each command keeps its own help text.
 */
export function usageError(
  write: (line: string) => void,
  helpHint: string,
  message: string,
): number {
  write(`jsails: ${message}`);
  write(helpHint);
  return 2;
}
