/**
 * Named-slot style contract for the authoring layer.
 *
 * Tailwind class strings are the tokens; the contract owns the slot names so
 * `render` can dereference `style.slot('header')` instead of threading a raw
 * class list through component props.  A raw Tailwind class string where a slot
 * is required is rejected at the type level: slot returns a single class string,
 * not an open string union.
 *
 * The raw-class-literal guard (rejecting a bare string where a slot is expected)
 * is a static / compile-time concern deferred to the Phase 6 transform; this
 * runtime module validates the slot map itself.
 */

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/** Raised when a style definition fails structural validation. Messages are value-free. */
export class StyleError extends Error {
  readonly code: StyleErrorCode;

  constructor(message: string, code: StyleErrorCode) {
    super(message);
    this.name = 'StyleError';
    this.code = code;
  }
}

/** Stable machine codes carried on a {@link StyleError}. */
export type StyleErrorCode = 'invalid_slots' | 'unknown_slot';

// ---------------------------------------------------------------------------
// Style contract
// ---------------------------------------------------------------------------

/**
 * A named-slot style contract. Each slot maps to a Tailwind class string the
 * component's `render` consumes via `style.slot(name)`.
 */
export interface StyleContract<Slots extends string = string> {
  readonly slots: Readonly<Record<Slots, string>>;
  slot(name: Slots): string;
}

// ---------------------------------------------------------------------------
// defineStyle
// ---------------------------------------------------------------------------

/**
 * Define a named-slot style contract from a flat map of slot name to Tailwind
 * class string.  Every value must be a non-empty string; every key must be a
 * non-empty string that is not an inherited object property (e.g. `__proto__`).
 *
 * Returns a frozen contract; `slot('x')` returns the registered class string.
 * An unknown slot throws a value-free {@link StyleError} (`unknown_slot`).
 */
export function defineStyle<const S extends Record<string, string>>(
  slots: S,
): StyleContract<keyof S & string> {
  if (slots === null || typeof slots !== 'object') {
    throw new StyleError('slots must be a plain object', 'invalid_slots');
  }

  const prototype = Object.getPrototypeOf(slots);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new StyleError('slots must be a plain object', 'invalid_slots');
  }

  const entries = Object.entries(slots);

  // Reject empty maps (a style with zero slots is an author mistake, not a
  // valid definition).
  if (entries.length === 0) {
    throw new StyleError('slots must have at least one entry', 'invalid_slots');
  }

  const frozenSlots: Record<string, string> = {};

  for (const [key, value] of entries) {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new StyleError('slot name must be a non-empty string', 'invalid_slots');
    }
    if (key in Object.prototype) {
      throw new StyleError(
        'slot name must not shadow an inherited object property',
        'invalid_slots',
      );
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw new StyleError('slot value must be a non-empty string', 'invalid_slots');
    }
    frozenSlots[key] = value;
  }

  const frozen = Object.freeze(frozenSlots);

  return Object.freeze({
    slots: frozen,
    slot(name: keyof S & string): string {
      const value = (frozen as Record<string, string>)[name];
      if (value === undefined) {
        throw new StyleError('unknown slot', 'unknown_slot');
      }
      return value;
    },
  });
}
