/**
 * Zod-derived field validation metadata tests.
 *
 * Covers `src/server-components/validation-meta.ts`: reducing a field's Zod
 * schema to the bounded, JSON-serializable {@link FieldValidationRules} shape
 * (`extractFieldRules`) and the marker serialization (`serializeFieldRules`),
 * including the value-free oversize failures.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  extractFieldRules,
  serializeFieldRules,
  ValidationMetaError,
} from '../../src/server-components/validation-meta.js';

describe('extractFieldRules — strings', () => {
  it('reduces a plain string to a required string hint', () => {
    assert.deepEqual(extractFieldRules(z.string()), { required: true, type: 'string' });
  });

  it('maps email and date string formats', () => {
    assert.deepEqual(extractFieldRules(z.string().email()), { required: true, type: 'email' });
    assert.deepEqual(extractFieldRules(z.string().date()), { required: true, type: 'date' });
  });

  it('carries string length bounds and the regex source', () => {
    assert.deepEqual(extractFieldRules(z.string().min(3).max(10)), {
      required: true,
      type: 'string',
      minLength: 3,
      maxLength: 10,
    });
    assert.deepEqual(extractFieldRules(z.string().regex(/^[a-z]+$/)), {
      required: true,
      type: 'string',
      pattern: '^[a-z]+$',
    });
  });
});

describe('extractFieldRules — optionality', () => {
  it('folds optional/nullable/default wrappers into required:false', () => {
    assert.deepEqual(extractFieldRules(z.string().optional()), { required: false, type: 'string' });
    assert.deepEqual(extractFieldRules(z.string().nullable()), { required: false, type: 'string' });
    assert.deepEqual(extractFieldRules(z.string().default('x')), {
      required: false,
      type: 'string',
    });
  });
});

describe('extractFieldRules — numbers', () => {
  it('reduces a plain number', () => {
    assert.deepEqual(extractFieldRules(z.number()), { required: true, type: 'number' });
  });

  it('carries min/max and step bounds', () => {
    assert.deepEqual(extractFieldRules(z.number().min(5).max(10)), {
      required: true,
      type: 'number',
      min: 5,
      max: 10,
    });
    assert.deepEqual(extractFieldRules(z.number().multipleOf(2)), {
      required: true,
      type: 'number',
      step: 2,
    });
  });

  it('treats int() as a plain number hint (no bounds)', () => {
    assert.deepEqual(extractFieldRules(z.number().int()), { required: true, type: 'number' });
  });
});

describe('extractFieldRules — boolean, date, enum', () => {
  it('reduces booleans and dates', () => {
    assert.deepEqual(extractFieldRules(z.boolean()), { required: true, type: 'boolean' });
    assert.deepEqual(extractFieldRules(z.date()), { required: true, type: 'date' });
  });

  it('copies enum options', () => {
    assert.deepEqual(extractFieldRules(z.enum(['a', 'b'])), {
      required: true,
      options: ['a', 'b'],
    });
  });
});

describe('extractFieldRules — unrepresentable schemas', () => {
  it('yields only the required flag for objects, arrays, unions, and literals', () => {
    assert.deepEqual(extractFieldRules(z.object({ a: z.string() })), { required: true });
    assert.deepEqual(extractFieldRules(z.array(z.string())), { required: true });
    assert.deepEqual(extractFieldRules(z.union([z.string(), z.number()])), { required: true });
    assert.deepEqual(extractFieldRules(z.literal('x')), { required: true });
  });
});

describe('extractFieldRules — oversize failures', () => {
  it('rejects a field with too many enum options', () => {
    assert.throws(
      () => extractFieldRules(z.enum(Array.from({ length: 51 }, (_, i) => `o${i}`))),
      (error: unknown) => error instanceof ValidationMetaError,
    );
  });

  it('rejects an enum option that is too long', () => {
    assert.throws(
      () => extractFieldRules(z.enum(['a'.repeat(65)])),
      (error: unknown) => error instanceof ValidationMetaError,
    );
  });

  it('rejects an oversized regex source', () => {
    assert.throws(
      () => extractFieldRules(z.string().regex(new RegExp('a'.repeat(257)))),
      (error: unknown) => error instanceof ValidationMetaError,
    );
  });
});

describe('serializeFieldRules', () => {
  it('returns undefined for an only-optional ruleset', () => {
    assert.equal(serializeFieldRules({ required: false }), undefined);
  });

  it('serializes a required hint', () => {
    assert.equal(serializeFieldRules({ required: true }), '{"required":true}');
  });

  it('rejects a ruleset whose JSON exceeds the marker bound', () => {
    assert.throws(
      () => serializeFieldRules({ required: true, pattern: 'a'.repeat(5000) }),
      (error: unknown) => error instanceof ValidationMetaError,
    );
  });
});
