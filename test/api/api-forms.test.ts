import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readForm } from '../../src/api/forms.js';
import type { FormResult } from '../../src/api/forms.js';
import { array, boolean, integer, object, string } from '../../src/api/validation.js';
import type { Infer } from '../../src/api/validation.js';

const loginSchema = object({
  email: string({ min: 1 }),
  password: string({ min: 8 }),
});

function formRequest(body: string, contentType = 'application/x-www-form-urlencoded'): Request {
  return new Request('https://x.test/form', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
}

describe('readForm', () => {
  it('parses form-urlencoded bodies into typed string values', async () => {
    const result = await readForm(
      formRequest('email=a%40b.c&password=hunter2-secret'),
      loginSchema,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.value, { email: 'a@b.c', password: 'hunter2-secret' });
    }
  });

  it('collects repeated form keys into string arrays', async () => {
    const schema = object({ tag: array(string()) });
    const result = await readForm(formRequest('tag=a&tag=b&tag=c'), schema);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.value, { tag: ['a', 'b', 'c'] });
    }
  });

  it('parses JSON bodies with native types preserved', async () => {
    const schema = object({ age: integer(), active: boolean() });
    const result = await readForm(
      formRequest('{"age":30,"active":true}', 'application/json'),
      schema,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.value, { age: 30, active: true });
    }
  });

  it('accepts a JSON content type with a charset parameter', async () => {
    const schema = object({ age: integer() });
    const result = await readForm(
      formRequest('{"age":30}', 'application/json; charset=utf-8'),
      schema,
    );
    assert.equal(result.ok, true);
  });

  it('defaults an absent content type to form-urlencoded', async () => {
    // A Request with no body carries no content-type header; the parser must
    // fall back to form parsing (an empty form) rather than reject it.
    const request = new Request('https://x.test/form', { method: 'POST' });
    const result = await readForm(request, loginSchema);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errors[0]?.code, 'required');
    }
  });

  it('returns value-free field errors for invalid input', async () => {
    const secret = 'hunter2-secret';
    const result = await readForm(
      formRequest(`email=a%40b.c&token=${secret}`),
      object({ email: string({ min: 1 }) }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      const unknown = result.errors.find((issue) => issue.code === 'unknown_field');
      assert.deepEqual(unknown?.path, ['token']);
      assert.ok(!JSON.stringify(result.errors).includes(secret));
    }
  });

  it('rejects a form field against a non-string schema (no implicit coercion)', async () => {
    const result = await readForm(formRequest('age=30'), object({ age: integer() }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errors[0]?.code, 'type');
    }
  });

  it('enforces the byte bound before parsing', async () => {
    const result = await readForm(
      formRequest('email=a%40b.c&password=' + 'x'.repeat(100)),
      loginSchema,
      {
        maxBytes: 16,
      },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errors[0]?.code, 'body_too_large');
      assert.equal(result.errors[0]?.path.length, 0);
    }
  });

  it('returns a value-free error for malformed JSON', async () => {
    const result = await readForm(formRequest('{ not json', 'application/json'), loginSchema);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errors[0]?.code, 'invalid_json');
    }
  });

  it('returns a value-free error for an unsupported content type', async () => {
    const result = await readForm(formRequest('raw-data', 'text/plain'), loginSchema);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errors[0]?.code, 'unsupported_content_type');
    }
  });

  it('rejects an invalid maxBytes option', async () => {
    await assert.rejects(readForm(formRequest('a=b'), loginSchema, { maxBytes: 0 }), TypeError);
  });

  it('produces a typed value matching the inferred schema output', async () => {
    const schema = object({ email: string({ min: 1 }), password: string({ min: 8 }) });
    const result: FormResult<Infer<typeof schema>> = await readForm(
      formRequest('email=a%40b.c&password=hunter2-secret'),
      schema,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      const value: { email: string; password: string } = result.value;
      assert.equal(value.email, 'a@b.c');
    }
  });
});
