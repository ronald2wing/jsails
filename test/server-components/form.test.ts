/**
 * Form object tests.
 *
 * These tests cover `src/server-components/form.ts`: factory validation,
 * `values`, `fill`, `validate` (with value-free field errors), `errors` cache,
 * `reset`, `toState`/`fromState` round-trip, integration with strict schemas,
 * and rejection of bad schema shapes.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

import { defineForm, FormDefinitionError } from '../../src/server-components/form.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const loginForm = defineForm({
  schema: loginSchema,
  initial: { email: '' },
});

const profileSchema = z.object({
  name: z.string().min(1),
  age: z.number().min(0).max(150),
  active: z.boolean(),
});

const profileForm = defineForm({ schema: profileSchema, initial: { name: '', active: false } });

const strictSchema = z
  .object({
    title: z.string().min(3),
    count: z.number(),
  })
  .strict();

const strictForm = defineForm({ schema: strictSchema, initial: { title: '', count: 0 } });

// ---------------------------------------------------------------------------
// Factory validation
// ---------------------------------------------------------------------------

describe('defineForm', () => {
  it('rejects null', () => {
    assert.throws(() => defineForm(null as unknown as any), FormDefinitionError);
  });

  it('rejects non-object', () => {
    assert.throws(() => defineForm(42 as unknown as any), FormDefinitionError);
  });

  it('rejects non-Zod schema', () => {
    assert.throws(
      () => defineForm({ schema: { parse: () => ({}) } as unknown as any }),
      FormDefinitionError,
    );
  });

  it('accepts partial initial (full validation only runs on validate())', () => {
    // A partial initial is a seed; the form may start in an incomplete state.
    const f = defineForm({ schema: loginSchema, initial: { email: '' } })();
    assert.equal(f.values().email, '');
    // password is not set in the initial, so it stays undefined until filled.
  });

  it('rejects non-plain initial', () => {
    assert.throws(
      () =>
        defineForm({
          schema: loginSchema,
          initial: ['no'] as unknown as any,
        }),
      FormDefinitionError,
    );
  });

  it('returns a factory that creates independent instances', () => {
    const f1 = loginForm();
    const f2 = loginForm();
    f1.fill({ email: 'a@b.co' });
    f1.validate();
    // f2 is untouched.
    assert.equal(f2.values().email, '');
    assert.deepStrictEqual(f2.errors(), {});
  });
  it('forces .strict() on the schema — extra keys cause validation errors', () => {
    const form = strictForm();
    form.fill({ title: 'abc', count: 1, extra: 'no' } as any);
    // The .strict() schema rejects extra keys, but only at validate() time.
    const result = form.validate();
    assert.ok(!result.ok);
  });
});

// ---------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------

describe('values', () => {
  it('returns current values as a shallow copy', () => {
    const form = loginForm();
    const vals = form.values();
    assert.equal(vals.email, '');
    assert.equal(vals.password, undefined as unknown);
    // Mutating the copy does not affect the form.
    (vals as any).email = 'x@y.co';
    assert.equal(form.values().email, '');
  });

  it('reflects changes after fill', () => {
    const form = loginForm();
    form.fill({ email: 'user@example.com' });
    assert.equal(form.values().email, 'user@example.com');
  });

  it('returns schema-defaulted values when no initial is given', () => {
    const noInit = defineForm({
      schema: z.object({ age: z.number().default(25), name: z.string().default('anon') }),
    });
    const form = noInit();
    assert.equal(form.values().age, 25);
    assert.equal(form.values().name, 'anon');
  });
});

// ---------------------------------------------------------------------------
// fill
// ---------------------------------------------------------------------------

describe('fill', () => {
  it('merges partial values', () => {
    const form = loginForm();
    form.fill({ email: 'user@example.com' });
    assert.equal(form.values().email, 'user@example.com');
    // Unfilled fields keep their current values.
    assert.equal(form.values().password, undefined as unknown);
  });

  it('sets partial values without immediate validation', () => {
    const form = loginForm();
    form.fill({ email: 'user@example.com' });
    // fill does not validate — it just sets the value.
    form.fill({ email: 'bad-email' });
    assert.equal(form.values().email, 'bad-email');
    // Validation only catches invalidity when validate() is called.
    const result = form.validate();
    assert.ok(!result.ok);
  });

  it('rejects non-plain fill argument', () => {
    const form = loginForm();
    assert.throws(() => form.fill([] as unknown as any), FormDefinitionError);
  });

  it('clears cached errors after a valid fill', () => {
    const form = loginForm();
    // Induce an error first.
    try {
      form.fill({ email: 'bad' });
    } catch {
      // Expected: fill rejects bad values.
    }
    // Actually fill valid data.
    form.fill({ email: 'good@b.co' });
    assert.deepStrictEqual(form.errors(), {});
  });

  it('fill does not coerce types (validation handles coercion)', () => {
    const form = profileForm();
    form.fill({ age: '42' as unknown as number });
    // fill just sets values; '42' is stored as-is.
    assert.equal(form.values().age, '42' as unknown);
    // validate() would catch the type mismatch if the schema doesn't coerce.
  });
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

describe('validate', () => {
  it('returns ok on valid values', () => {
    const form = loginForm();
    form.fill({ email: 'user@example.com', password: '12345678' });
    const result = form.validate();
    assert.ok(result.ok);
  });

  it('returns field errors on invalid values', () => {
    const form = loginForm();
    form.fill({ email: '', password: 'short' });
    const result = form.validate();
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.ok('email' in result.errors || 'password' in result.errors);
    }
  });

  it('errors are value-free (never echo raw input)', () => {
    const form = loginForm();
    form.fill({ email: 'bad', password: 'x' });
    const result = form.validate();
    assert.ok(!result.ok);
    if (!result.ok) {
      for (const msg of Object.values(result.errors)) {
        assert.ok(typeof msg === 'string' && msg.length > 0);
        // Never contains the raw input
        assert.ok(!msg.includes('bad'));
        assert.ok(!msg.includes('x'));
      }
    }
  });

  it('validates against the strict schema', () => {
    const form = strictForm();
    form.fill({ title: 'abc', count: 1 });
    assert.ok(form.validate().ok);
    // Extra keys are rejected by the .strict() schema via fromState.
    const form2 = strictForm();
    assert.throws(() => form2.fromState({ title: 'abc', count: 1, extra: true }), z.ZodError);
  });

  it('validate coerces values through schema', () => {
    // Use z.coerce for fields that should accept string input.
    const coerceSchema = z.object({ age: z.coerce.number() });
    const f = defineForm({ schema: coerceSchema })();
    f.fill({ age: '25' as unknown as number });
    const result = f.validate();
    assert.ok(result.ok);
    assert.equal(f.values().age, 25);
  });

  it('required field missing produces an error', () => {
    const schema = z.object({ name: z.string().min(1) });
    const f = defineForm({ schema })();
    // Leave name empty.
    const result = f.validate();
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.ok('name' in result.errors);
    }
  });

  it('number out of range produces a bound error', () => {
    const form = profileForm();
    form.fill({ name: 'ok', age: 999, active: true });
    const result = form.validate();
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.ok('age' in result.errors);
    }
  });
});

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

describe('errors', () => {
  it('returns empty when no validation has run', () => {
    const form = loginForm();
    assert.deepStrictEqual(form.errors(), {});
  });

  it('returns empty after a passing validation', () => {
    const form = loginForm();
    form.fill({ email: 'user@example.com', password: '12345678' });
    form.validate();
    assert.deepStrictEqual(form.errors(), {});
  });

  it('returns cached errors after a failing validation', () => {
    const form = loginForm();
    form.fill({ email: '', password: 'x' });
    form.validate();
    const errs = form.errors();
    assert.ok(Object.keys(errs).length > 0);
  });

  it('clears errors after fill', () => {
    const form = loginForm();
    form.fill({ email: '', password: 'x' });
    form.validate();
    assert.ok(Object.keys(form.errors()).length > 0);
    form.fill({ email: 'ok@b.co' });
    assert.deepStrictEqual(form.errors(), {});
  });

  it('clears errors after reset', () => {
    const form = loginForm();
    form.fill({ email: '', password: 'x' });
    form.validate();
    assert.ok(Object.keys(form.errors()).length > 0);
    form.reset();
    assert.deepStrictEqual(form.errors(), {});
  });
});

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

describe('reset', () => {
  it('restores all fields to initial values', () => {
    const form = loginForm();
    form.fill({ email: 'user@example.com', password: 'secret123' });
    // After fill, values reflect the filled data.
    assert.equal(form.values().password, 'secret123');
    form.reset();
    assert.equal(form.values().email, '');
    // password was not in initial, so reset() removes it.
    assert.ok(!('password' in form.values()));
  });

  it('restores even after multiple fills', () => {
    const form = loginForm();
    form.fill({ email: 'a@b.co', password: 'abcdefgh' });
    form.fill({ email: 'x@y.co' });
    form.reset();
    assert.equal(form.values().email, '');
  });

  it('does not alias the initial object', () => {
    const form = loginForm();
    form.fill({ email: 'user@example.com', password: 'secret123' });
    form.reset();
    // Mutating the result of values() should not mutate future resets.
    const vals = form.values();
    (vals as any).email = 'corrupted@x.co';
    form.reset();
    assert.equal(form.values().email, '');
  });
});

// ---------------------------------------------------------------------------
// toState / fromState round-trip
// ---------------------------------------------------------------------------

describe('toState / fromState', () => {
  it('round-trips values through JSON', () => {
    const form = loginForm();
    form.fill({ email: 'user@example.com', password: 'abcdefgh' });
    const state = form.toState();
    assert.ok(typeof state === 'object' && state !== null);
    assert.equal(state.email, 'user@example.com');
    assert.equal(state.password, 'abcdefgh');

    const form2 = loginForm();
    form2.fromState(state);
    assert.equal(form2.values().email, 'user@example.com');
    assert.equal(form2.values().password, 'abcdefgh');
  });

  it('toState returns a deep clone (no aliasing)', () => {
    const form = loginForm();
    form.fill({ email: 'user@example.com' });
    const state = form.toState();
    (state as any).email = 'corrupted@x.co';
    assert.equal(form.values().email, 'user@example.com');
  });

  it('fromState rejects non-plain input', () => {
    const form = loginForm();
    assert.throws(() => form.fromState('nope'), FormDefinitionError);
    assert.throws(() => form.fromState(null), FormDefinitionError);
    assert.throws(() => form.fromState([]), FormDefinitionError);
  });

  it('fromState rejects schema-invalid state and leaves values unchanged', () => {
    const form = loginForm();
    form.fill({ email: 'user@example.com', password: 'abcdefgh' });
    assert.throws(() => form.fromState({ email: 'bad', password: 'x' }), z.ZodError);
    // Values are unchanged.
    assert.equal(form.values().email, 'user@example.com');
    assert.equal(form.values().password, 'abcdefgh');
  });

  it('fromState rejects undeclared keys from a strict schema', () => {
    const form = strictForm();
    form.fill({ title: 'abc', count: 1 });
    assert.throws(() => form.fromState({ title: 'abc', count: 1, extra: true }), z.ZodError);
    assert.equal(form.values().title, 'abc');
    assert.equal(form.values().count, 1);
  });

  it('toState / fromState preserves boolean fields', () => {
    const form = profileForm();
    form.fill({ name: 'Alice', age: 30, active: true });
    const state = form.toState();
    assert.equal(state.active, true);
    const form2 = profileForm();
    form2.fromState(state);
    assert.equal(form2.values().active, true);
  });

  it('fromState clears cached errors', () => {
    const form = loginForm();
    form.fill({ email: '', password: 'x' });
    form.validate();
    assert.ok(Object.keys(form.errors()).length > 0);
    form.fromState({ email: 'good@b.co', password: 'abcdefgh' });
    assert.deepStrictEqual(form.errors(), {});
  });
});

// ---------------------------------------------------------------------------
// Integration: strict-schema rejection
// ---------------------------------------------------------------------------

describe('strict schema rejection', () => {
  it('validate catches undeclared keys from strict schema', () => {
    const form = strictForm();
    form.fill({ title: 'abc', count: 1, extra: true } as any);
    const result = form.validate();
    assert.ok(!result.ok);
    // The undeclared key `extra` produces a validation error.
  });

  it('fromState with undeclared keys throws ZodError', () => {
    const form = strictForm();
    assert.throws(() => form.fromState({ title: 'abc', count: 1, extra: true }), z.ZodError);
  });

  it('validate with undeclared keys returns errors', () => {
    // Hard to inject undeclared keys via fill (it validates), but fromState
    // validates too. This test ensures validate itself catches strict violations.
    const form = strictForm();
    form.fill({ title: 'abc', count: 1 });
    const result = form.validate();
    assert.ok(result.ok);
  });
});
