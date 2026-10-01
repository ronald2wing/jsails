/**
 * Logging errors: a value-free error class for the logging service.
 *
 * Every error message is constructed from the fixed `code` and a
 * developer-facing description — never from a caller-supplied value — so
 * errors are safe to introspect in any environment.
 */

/** Discriminated codes for errors raised by the logging service. */
export type LoggerErrorCode = 'invalid_level' | 'unknown_channel' | 'invalid_options';

/**
 * A value-free error raised by the logging service. The message explains the
 * condition that failed but never echoes a caller-supplied value (e.g. the
 * invalid level string itself).
 */
export class LoggerError extends Error {
  readonly code: LoggerErrorCode;

  constructor(code: LoggerErrorCode, message: string) {
    super(message);
    this.name = 'LoggerError';
    this.code = code;
  }
}
