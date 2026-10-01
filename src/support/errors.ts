/**
 * Base class for every `jsails/support` domain error.
 *
 * Non-exported from the package barrel: it exists so the value-free contract and
 * `instanceof` checks live in one place. Each domain owns its own subclass
 * (`StrError`, `NumError`, ...) whose name names the failing domain.
 */
export abstract class SupportError extends Error {
  /** Stable, machine-readable failure code. Never derived from user input. */
  abstract readonly code: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}
