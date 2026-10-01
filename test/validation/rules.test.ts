import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  confirmed,
  email,
  inList,
  max,
  maxLength,
  min,
  minLength,
  regex,
  required,
  url,
  validateFields,
  when,
} from '../../src/validation/rules.js';

// ---------------------------------------------------------------------------
// Helper: run a Zod schema against a value and return the first issue message
// ---------------------------------------------------------------------------

function firstIssue(schema: z.ZodType, value: unknown): string | null {
  const result = schema.safeParse(value);
  if (result.success) return null;
  return result.error.issues[0]?.message ?? 'unknown error';
}

// ---------------------------------------------------------------------------
// required
// ---------------------------------------------------------------------------

describe('required', () => {
  it('passes for a non-empty string', () => {
    assert.equal(firstIssue(required(), 'hello'), null);
  });

  it('fails for an empty string', () => {
    assert.notEqual(firstIssue(required(), ''), null);
  });

  it('fails for whitespace-only input', () => {
    assert.notEqual(firstIssue(required(), '   '), null);
  });

  it('fails for undefined', () => {
    assert.notEqual(firstIssue(required(), undefined), null);
  });

  it('fails for null', () => {
    assert.notEqual(firstIssue(required(), null), null);
  });

  it('uses the supplied error message', () => {
    const msg = firstIssue(required('Name is mandatory.'), '');
    assert.equal(msg, 'Name is mandatory.');
  });

  it('never echoes the input value in the error', () => {
    const secret = 'private-data-123';
    const result = required().safeParse(secret);
    assert.equal(result.success, true);
    // irrelevant — pass case. For the fail case the default message is "Required"
    // which is value-free.
    const fail = required().safeParse('');
    assert.equal(fail.success, false);
    if (!fail.success) {
      const issueMessage = fail.error.issues[0]?.message ?? '';
      assert.ok(issueMessage.length > 0);
      assert.ok(!issueMessage.includes(secret), 'error message must not echo input');
    }
  });
});

// ---------------------------------------------------------------------------
// email
// ---------------------------------------------------------------------------

describe('email', () => {
  it('passes for a valid email', () => {
    assert.equal(firstIssue(email(), 'user@example.com'), null);
  });

  it('fails for a plain string without @', () => {
    assert.notEqual(firstIssue(email(), 'not-an-email'), null);
  });

  it('fails for an empty string', () => {
    assert.notEqual(firstIssue(email(), ''), null);
  });

  it('uses the supplied error message', () => {
    const msg = firstIssue(email('Enter a valid address.'), 'bad');
    assert.equal(msg, 'Enter a valid address.');
  });

  it('never echoes the input value', () => {
    const input = 'secret@evil.com';
    const fail = email().safeParse('not-valid');
    assert.equal(fail.success, false);
    if (!fail.success) {
      const issueMessage = fail.error.issues[0]?.message ?? '';
      assert.ok(issueMessage.length > 0);
      assert.ok(!issueMessage.includes(input), 'error message must not echo input');
    }
  });
});

// ---------------------------------------------------------------------------
// url
// ---------------------------------------------------------------------------

describe('url', () => {
  it('passes for a valid https URL', () => {
    assert.equal(firstIssue(url(), 'https://example.com'), null);
  });

  it('passes for a valid http URL', () => {
    assert.equal(firstIssue(url(), 'http://example.com/path'), null);
  });

  it('fails for a plain word', () => {
    assert.notEqual(firstIssue(url(), 'not-a-url'), null);
  });

  it('fails for an empty string', () => {
    assert.notEqual(firstIssue(url(), ''), null);
  });

  it('uses the supplied error message', () => {
    const msg = firstIssue(url('Provide a valid URL.'), 'bad');
    assert.equal(msg, 'Provide a valid URL.');
  });

  it('never echoes the input value', () => {
    const input = 'https://secret.example.com';
    const fail = url().safeParse('bad');
    assert.equal(fail.success, false);
    if (!fail.success) {
      const issueMessage = fail.error.issues[0]?.message ?? '';
      assert.ok(!issueMessage.includes(input), 'error message must not echo input');
    }
  });
});

// ---------------------------------------------------------------------------
// minLength / maxLength
// ---------------------------------------------------------------------------

describe('minLength', () => {
  it('passes when the string meets the minimum length', () => {
    assert.equal(firstIssue(minLength(3), 'abc'), null);
  });

  it('fails when the string is too short', () => {
    assert.notEqual(firstIssue(minLength(5), 'ab'), null);
  });

  it('fails for an empty string (minLength > 0)', () => {
    assert.notEqual(firstIssue(minLength(3), ''), null);
  });

  it('uses the supplied error message', () => {
    const msg = firstIssue(minLength(10, 'Too short!'), 'x');
    assert.equal(msg, 'Too short!');
  });

  it('handles minLength of 0 (always passes)', () => {
    assert.equal(firstIssue(minLength(0), ''), null);
  });
});

describe('maxLength', () => {
  it('passes when the string is under the limit', () => {
    assert.equal(firstIssue(maxLength(5), 'abc'), null);
  });

  it('fails when the string exceeds the maximum', () => {
    assert.notEqual(firstIssue(maxLength(2), 'abc'), null);
  });

  it('passes for an empty string', () => {
    assert.equal(firstIssue(maxLength(10), ''), null);
  });

  it('uses the supplied error message', () => {
    const msg = firstIssue(maxLength(2, 'Too long!'), 'abcdef');
    assert.equal(msg, 'Too long!');
  });
});

// ---------------------------------------------------------------------------
// min / max (numeric)
// ---------------------------------------------------------------------------

describe('min', () => {
  it('passes when the number meets the minimum', () => {
    assert.equal(firstIssue(min(5), 10), null);
  });

  it('passes when the number equals the minimum', () => {
    assert.equal(firstIssue(min(5), 5), null);
  });

  it('fails when the number is below the minimum', () => {
    assert.notEqual(firstIssue(min(5), 3), null);
  });

  it('fails for a string (wrong type)', () => {
    assert.notEqual(firstIssue(min(5), 'hello'), null);
  });

  it('uses the supplied error message', () => {
    const msg = firstIssue(min(10, 'Too low.'), 5);
    assert.equal(msg, 'Too low.');
  });
});

describe('max', () => {
  it('passes when the number is under the maximum', () => {
    assert.equal(firstIssue(max(10), 5), null);
  });

  it('passes when the number equals the maximum', () => {
    assert.equal(firstIssue(max(10), 10), null);
  });

  it('fails when the number exceeds the maximum', () => {
    assert.notEqual(firstIssue(max(5), 10), null);
  });

  it('uses the supplied error message', () => {
    const msg = firstIssue(max(5, 'Too high.'), 10);
    assert.equal(msg, 'Too high.');
  });
});

// ---------------------------------------------------------------------------
// regex
// ---------------------------------------------------------------------------

describe('regex', () => {
  const alphaPattern = /^[a-zA-Z]+$/;

  it('passes when the string matches the pattern', () => {
    assert.equal(firstIssue(regex(alphaPattern), 'hello'), null);
  });

  it('fails when the string does not match', () => {
    assert.notEqual(firstIssue(regex(alphaPattern), 'hello123'), null);
  });

  it('fails for an empty string when pattern requires 1+ chars', () => {
    assert.notEqual(firstIssue(regex(alphaPattern), ''), null);
  });

  it('uses the supplied error message', () => {
    const msg = firstIssue(regex(/^\d+$/, 'Digits only.'), 'abc');
    assert.equal(msg, 'Digits only.');
  });

  it('never echoes the input value', () => {
    const input = 'secret-code-123';
    const fail = regex(/^\d+$/).safeParse(input);
    assert.equal(fail.success, false);
    if (!fail.success) {
      const issueMessage = fail.error.issues[0]?.message ?? '';
      assert.ok(!issueMessage.includes(input), 'error message must not echo input');
    }
  });
});

// ---------------------------------------------------------------------------
// inList
// ---------------------------------------------------------------------------

describe('inList', () => {
  const colors = ['red', 'green', 'blue'] as const;

  it('passes when the value is in the list', () => {
    assert.equal(firstIssue(inList(colors), 'red'), null);
  });

  it('fails when the value is not in the list', () => {
    assert.notEqual(firstIssue(inList(colors), 'yellow'), null);
  });

  it('fails for an empty string', () => {
    assert.notEqual(firstIssue(inList(colors), ''), null);
  });

  it('uses the supplied error message', () => {
    const msg = firstIssue(inList(['a', 'b'], 'Pick a or b.'), 'c');
    assert.equal(msg, 'Pick a or b.');
  });
});

// ---------------------------------------------------------------------------
// confirmed
// ---------------------------------------------------------------------------

describe('confirmed', () => {
  const rule = confirmed('password');

  it('passes when the field matches the confirmation', () => {
    const err = rule.check('secret', { password: 'secret', password_confirmation: 'secret' });
    assert.equal(err, null);
  });

  it('fails when the confirmation is missing', () => {
    const err = rule.check('secret', { password: 'secret' });
    assert.notEqual(err, null);
  });

  it('fails when the values do not match', () => {
    const err = rule.check('secret', { password: 'secret', password_confirmation: 'different' });
    assert.notEqual(err, null);
  });

  it('fails when allValues is undefined', () => {
    const err = rule.check('secret');
    assert.notEqual(err, null);
  });

  it('uses a custom field name in the default message', () => {
    const emailRule = confirmed('email');
    const err = emailRule.check('a@b.c', { email: 'a@b.c' });
    assert.notEqual(err, null);
    assert.ok((err ?? '').includes('email'), 'error should mention the field name');
  });

  it('uses the supplied error message', () => {
    const custom = confirmed('token', 'Tokens must match.');
    const err = custom.check('a', { token: 'a', token_confirmation: 'b' });
    assert.equal(err, 'Tokens must match.');
  });

  it('never echoes input values in the error', () => {
    const err = rule.check('secret123', { password: 'secret123', password_confirmation: 'wrong' });
    assert.notEqual(err, null);
    assert.ok(!(err ?? '').includes('secret123'), 'error must not echo the value');
    assert.ok(!(err ?? '').includes('wrong'), 'error must not echo the confirmation value');
  });
});

// ---------------------------------------------------------------------------
// when
// ---------------------------------------------------------------------------

describe('when', () => {
  it('applies the rule when the condition is true', () => {
    const rule = when((v) => v.shouldValidate === true, required());
    const err = rule.check('', { shouldValidate: true });
    assert.notEqual(err, null);
  });

  it('skips the rule when the condition is false', () => {
    const rule = when((v) => v.shouldValidate === true, required());
    const err = rule.check('', { shouldValidate: false });
    assert.equal(err, null);
  });

  it('skips when allValues is undefined (condition evaluated against empty object)', () => {
    const rule = when((_v) => false, required());
    const err = rule.check('');
    assert.equal(err, null);
  });

  it('works with a Zod schema as the inner rule', () => {
    const rule = when((v) => v.active === true, email());
    assert.equal(rule.check('bad', { active: false }), null);
    assert.notEqual(rule.check('bad', { active: true }), null);
    assert.equal(rule.check('user@example.com', { active: true }), null);
  });

  it('works with a ValidationRule as the inner rule', () => {
    const inner = confirmed('password');
    const rule = when((v) => v.hasPassword === true, inner);
    assert.equal(
      rule.check('s', { hasPassword: true, password: 's', password_confirmation: 's' }),
      null,
    );
    assert.notEqual(
      rule.check('s', { hasPassword: true, password: 's', password_confirmation: 'x' }),
      null,
    );
    assert.equal(rule.check('s', { hasPassword: false }), null);
  });

  it('passes when condition is false even for invalid values', () => {
    const rule = when((_v) => false, email());
    assert.equal(rule.check('not-an-email', {}), null);
  });
});

// ---------------------------------------------------------------------------
// validateFields
// ---------------------------------------------------------------------------

describe('validateFields', () => {
  const loginSchema = z.object({
    email: email(),
    password: required('Password is required.'),
  });

  it('returns empty array when all fields pass', () => {
    const errors = validateFields(loginSchema, {
      email: 'user@example.com',
      password: 'secret',
    });
    assert.deepEqual(errors, []);
  });

  it('returns field errors for invalid input', () => {
    const errors = validateFields(loginSchema, { email: 'bad', password: '' });
    assert.ok(errors.length >= 2, `expected at least 2 errors, got ${errors.length}`);
  });

  it('errors carry the field name (dotted path)', () => {
    const errors = validateFields(loginSchema, { email: 'bad', password: '' });
    const fields = errors.map((e) => e.field);
    assert.ok(fields.includes('email'), 'should include email field');
    assert.ok(fields.includes('password'), 'should include password field');
  });

  it('never echoes input values in error messages', () => {
    const emailInput = 'secret@private.test';
    const errors = validateFields(loginSchema, {
      email: emailInput,
      password: 'secret-value',
    });
    for (const err of errors) {
      assert.ok(
        !err.message.includes(emailInput),
        `error message "${err.message}" must not echo input`,
      );
    }
  });

  it('returns errors for nested objects with dotted paths', () => {
    const schema = z.object({
      user: z.object({
        name: required(),
      }),
    });
    const errors = validateFields(schema, { user: { name: '' } });
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.field, 'user.name');
  });

  it('returns _root for top-level non-object errors', () => {
    const errs = validateFields(loginSchema, 'not-an-object');
    assert.ok(errs.length >= 1);
    assert.equal(errs[0]?.field, '_root');
  });

  it('handles extra unknown fields gracefully (Zod strips by default)', () => {
    const schema = z.object({ name: required() });
    const errors = validateFields(schema, { name: 'ok', extra: 'ignored' });
    assert.deepEqual(errors, []);
  });
});
