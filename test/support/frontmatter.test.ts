import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FrontmatterError,
  parseFrontmatter,
  serializeError,
} from '../../src/support/frontmatter.server.js';

describe('parseFrontmatter', () => {
  it('parses YAML frontmatter into data + content', () => {
    const doc = ['---', 'title: Hello', 'tags:', '  - a', '  - b', '---', '# Body', 'text'].join(
      '\n',
    );
    const { data, content } = parseFrontmatter<{ title: string; tags: string[] }>(doc);
    assert.equal(data.title, 'Hello');
    assert.deepEqual(data.tags, ['a', 'b']);
    assert.match(content, /# Body/);
    assert.equal(content.includes('title: Hello'), false);
  });

  it('returns empty data when there is no frontmatter block', () => {
    const { data, content } = parseFrontmatter('Just body text');
    assert.deepEqual(data, {});
    assert.match(content, /Just body text/);
  });

  it('throws invalid_argument value-free for a non-string input', () => {
    assert.throws(
      () => parseFrontmatter(42 as unknown as string),
      (error: unknown) => {
        assert.ok(error instanceof FrontmatterError);
        assert.equal(error.code, 'invalid_argument');
        return true;
      },
    );
  });

  it('wraps a malformed document as invalid_argument', () => {
    // An unterminated YAML flow sequence inside frontmatter makes gray-matter throw.
    const doc = '---\ntitle: [unterminated\n---\nbody';
    assert.throws(
      () => parseFrontmatter(doc),
      (error: unknown) => {
        assert.ok(error instanceof FrontmatterError);
        assert.equal(error.code, 'invalid_argument');
        return true;
      },
    );
  });
});

describe('serializeError', () => {
  it('serializes an Error into a plain JSON-safe object', () => {
    const result = serializeError(new Error('boom'));
    assert.equal(result.message, 'boom');
    assert.equal(result.name, 'Error');
    // JSON-safe: it round-trips.
    assert.doesNotThrow(() => JSON.stringify(result));
  });

  it('serializes a non-Error value without throwing', () => {
    const result = serializeError('a string');
    assert.doesNotThrow(() => JSON.stringify(result));
    assert.equal(typeof result, 'object');
  });

  it('captures a custom error code property', () => {
    const error = Object.assign(new Error('x'), { code: 'custom_code' });
    assert.equal(serializeError(error).code, 'custom_code');
  });
});
