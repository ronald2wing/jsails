import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { mapZodIssues } from '../../src/internal/zod.js';

describe('mapZodIssues', () => {
  it('returns an empty array for valid parsing', () => {
    const result = z.string().safeParse('hello');
    assert.ok(result.success);
    const entries = mapZodIssues([]);
    assert.deepStrictEqual(entries, []);
  });

  it('maps a top-level type error to _root path', () => {
    const result = z.string().safeParse(42);
    assert.ok(!result.success);

    const entries = mapZodIssues(result.error);
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.path, '_root');
    assert.equal(entry.code, 'invalid_type');
    assert.equal(entry.message, 'expected a string');
  });

  it('maps nested object paths to dotted strings', () => {
    const schema = z.object({ user: z.object({ name: z.string() }) }).strict();
    const result = schema.safeParse({ user: { name: 123 } });
    assert.ok(!result.success);

    const entries = mapZodIssues(result.error);
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.path, 'user.name');
    assert.equal(entry.code, 'invalid_type');
    assert.equal(entry.message, 'expected a string');
  });

  it('maps array index paths to dotted strings', () => {
    const schema = z.object({ tags: z.array(z.string()) });
    const result = schema.safeParse({ tags: ['a', 1, 'b'] });
    assert.ok(!result.success);

    const entries = mapZodIssues(result.error);
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.path, 'tags.1');
    assert.equal(entry.code, 'invalid_type');
    assert.equal(entry.message, 'expected a string');
  });

  it('maps too_small with the numeric bound', () => {
    const result = z.number().min(10).safeParse(3);
    assert.ok(!result.success);

    const entries = mapZodIssues(result.error);
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.code, 'too_small');
    assert.equal(entry.message, 'must be at least 10');
  });

  it('maps too_big with the numeric bound', () => {
    const result = z.number().max(100).safeParse(200);
    assert.ok(!result.success);

    const entries = mapZodIssues(result.error);
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.code, 'too_big');
    assert.equal(entry.message, 'must be at most 100');
  });

  it('maps invalid_format to a stable message without echoing input', () => {
    const result = z.string().email().safeParse('not-an-email');
    assert.ok(!result.success);

    const entries = mapZodIssues(result.error);
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.code, 'invalid_format');
    assert.equal(entry.message, 'invalid format');
  });

  it('maps custom (refine) failures to a stable value-free message', () => {
    // Zod emits code 'custom' for .refine() / .superRefine() failures.
    const schema = z.string().refine(() => false, { message: 'must be magic' });
    const result = schema.safeParse('hello');
    assert.ok(!result.success);

    const entries = mapZodIssues(result.error);
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.code, 'custom');
    // The custom Zod message ('must be magic') is NOT echoed — value-free only.
    assert.equal(entry.message, 'invalid value');
  });

  it('expands unrecognized_keys with key in path, value-free message', () => {
    const schema = z.object({ name: z.string() }).strict();
    const result = schema.safeParse({ name: 'ok', extra: 1, hidden: true });
    assert.ok(!result.success);

    const entries = mapZodIssues(result.error);
    assert.equal(entries.length, 2);

    const paths = entries.map((e) => e.path).sort();
    assert.deepStrictEqual(paths, ['extra', 'hidden']);

    for (const entry of entries) {
      assert.equal(entry.code, 'unrecognized_keys');
      // Message is value-free — never echoes the offending key name.
      assert.equal(entry.message, 'unrecognized field');
    }
  });

  it('expands nested unrecognized_keys with dotted paths', () => {
    const schema = z.object({ user: z.object({ name: z.string() }).strict() });
    const result = schema.safeParse({ user: { name: 'ok', secret: 'x' } });
    assert.ok(!result.success);

    const entries = mapZodIssues(result.error);
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.path, 'user.secret');
    assert.equal(entry.code, 'unrecognized_keys');
    assert.equal(entry.message, 'unrecognized field');
  });

  it('returns multiple entries for multiple independent issues', () => {
    const schema = z.object({ age: z.number().min(18), name: z.string() }).strict();
    const result = schema.safeParse({ age: 10, name: 1, extra: true });
    assert.ok(!result.success);

    const entries = mapZodIssues(result.error);
    // age.too_small + name.invalid_type + extra.unrecognized_keys = 3
    assert.equal(entries.length, 3);

    const byPath: Record<string, (typeof entries)[number]> = {};
    for (const entry of entries) {
      byPath[entry.path] = entry;
    }

    assert.equal(byPath['age']?.code, 'too_small');
    assert.equal(byPath['age']?.message, 'must be at least 18');
    assert.equal(byPath['name']?.code, 'invalid_type');
    assert.equal(byPath['name']?.message, 'expected a string');
    assert.equal(byPath['extra']?.code, 'unrecognized_keys');
    assert.equal(byPath['extra']?.message, 'unrecognized field');
  });

  it('messages never echo input values', () => {
    // Use a Zod string with a custom refine message that could leak
    // private data if echoed verbatim.
    const schema = z.string().refine(() => false, { message: 'secret_api_key=xyz123' });
    const result = schema.safeParse('any-input');
    assert.ok(!result.success);

    const entries = mapZodIssues(result.error);
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    // The custom message must NOT appear — only the stable code-based value.
    assert.equal(entry.message, 'invalid value');
    assert.ok(!entry.message.includes('secret'), 'message must not leak secrets');
  });

  it('accepts a ZodError or an issues array directly', () => {
    const schema = z.string();
    const result = schema.safeParse(42);
    assert.ok(!result.success);

    const fromError = mapZodIssues(result.error);
    const fromIssues = mapZodIssues(result.error.issues);

    assert.deepStrictEqual(fromError, fromIssues);
  });

  it('handles a string too_small bound correctly', () => {
    const result = z.string().min(3).safeParse('ab');
    assert.ok(!result.success);

    const entries = mapZodIssues(result.error);
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.code, 'too_small');
    assert.equal(entry.message, 'must be at least 3');
  });

  it('maps invalid_value code to a stable message', () => {
    // Test the 'invalid_value' code path directly, since it is hard to
    // trigger reliably with built-in Zod validators across versions.
    const entries = mapZodIssues([
      { code: 'invalid_value', path: ['field'], message: 'zod-custom-msg' },
    ] as z.ZodIssue[]);
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.path, 'field');
    assert.equal(entry.code, 'invalid_value');
    // The message must be our stable one, not zod's.
    assert.equal(entry.message, 'invalid value');
  });
});
