import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_TAG_LENGTH,
  MAX_TAGS,
  normalizeTags,
  TagError,
  tagFilter,
  TAG_OPTION_KEY,
} from '../../src/jobs/tags.js';

describe('normalizeTags', () => {
  it('deduplicates and trims tags preserving first-occurrence order', () => {
    const result = normalizeTags(['a', 'a', ' b ']);
    assert.deepEqual(result, ['a', 'b']);
  });

  it('truncates to MAX_TAGS when input exceeds the bound', () => {
    const tags: string[] = [];
    for (let i = 1; i <= MAX_TAGS + 5; i++) {
      tags.push(`tag${i}`);
    }
    const result = normalizeTags(tags);
    assert.equal(result.length, MAX_TAGS);
    assert.deepEqual(result, tags.slice(0, MAX_TAGS));
  });

  it('rejects a non-string element with TagError', () => {
    assert.throws(
      () => normalizeTags([42]),
      (err: unknown) => {
        assert.ok(err instanceof TagError);
        assert.equal(err.code, 'invalid_tag');
        assert.match(err.message, /string/);
        return true;
      },
    );
  });

  it('rejects a null element with TagError', () => {
    assert.throws(() => normalizeTags([null]), TagError);
  });

  it('rejects an empty string after trim with TagError', () => {
    assert.throws(
      () => normalizeTags(['  ']),
      (err: unknown) => {
        assert.ok(err instanceof TagError);
        assert.match((err as Error).message, /empty/);
        return true;
      },
    );
  });

  it('rejects a tag longer than MAX_TAG_LENGTH with TagError', () => {
    const long = 'x'.repeat(MAX_TAG_LENGTH + 1);
    assert.throws(
      () => normalizeTags([long]),
      (err: unknown) => {
        assert.ok(err instanceof TagError);
        assert.match((err as Error).message, new RegExp(String(MAX_TAG_LENGTH)));
        return true;
      },
    );
  });

  it('accepts a tag exactly MAX_TAG_LENGTH characters', () => {
    const exact = 'x'.repeat(MAX_TAG_LENGTH);
    const result = normalizeTags([exact]);
    assert.deepEqual(result, [exact]);
  });

  it('rejects a non-array value with TagError', () => {
    assert.throws(
      () => normalizeTags('not-an-array'),
      (err: unknown) => {
        assert.ok(err instanceof TagError);
        assert.match((err as Error).message, /array/);
        return true;
      },
    );
  });

  it('accepts an empty array and returns an empty frozen array', () => {
    const result = normalizeTags([]);
    assert.equal(result.length, 0);
    assert.ok(Object.isFrozen(result));
  });

  it('returns a frozen array', () => {
    const result = normalizeTags(['a']);
    assert.ok(Object.isFrozen(result));
    assert.throws(() => {
      (result as string[]).push('b');
    }, TypeError);
  });

  it('deduplicates after trimming', () => {
    const result = normalizeTags(['  production  ', 'production', 'PRODUCTION']);
    assert.deepEqual(result, ['production', 'PRODUCTION']);
  });

  it('stops collecting after MAX_TAGS even after dedup', () => {
    // 15 unique tags, first 10 should survive
    const tags: string[] = [];
    for (let i = 0; i < 15; i++) {
      tags.push(`t${i}`);
    }
    const result = normalizeTags(tags);
    assert.equal(result.length, MAX_TAGS);
  });
});

describe('tagFilter', () => {
  it('returns true when every requested tag is present', () => {
    const filter = tagFilter(['a']);
    assert.equal(filter(['a', 'b']), true);
  });

  it('returns false when a requested tag is missing', () => {
    const filter = tagFilter(['a']);
    assert.equal(filter(['b', 'c']), false);
  });

  it('returns true when multiple requested tags are all present', () => {
    const filter = tagFilter(['a', 'c']);
    assert.equal(filter(['a', 'b', 'c']), true);
  });

  it('returns false when only some requested tags are present', () => {
    const filter = tagFilter(['a', 'd']);
    assert.equal(filter(['a', 'b', 'c']), false);
  });

  it('returns false when entryTags is undefined', () => {
    const filter = tagFilter(['a']);
    assert.equal(filter(undefined), false);
  });

  it('returns false when entryTags is not an array', () => {
    const filter = tagFilter(['a']);
    assert.equal(filter('nope' as unknown as readonly string[]), false);
  });

  it('returns true when requested tags are empty (vacuously satisfied)', () => {
    const filter = tagFilter([]);
    assert.equal(filter(['a']), true);
  });

  it('returns true when both requested and entry tags are empty', () => {
    const filter = tagFilter([]);
    assert.equal(filter([]), true);
  });

  it('returns false when requested tags are empty but entryTags is undefined', () => {
    const filter = tagFilter([]);
    assert.equal(filter(undefined), false);
  });
});

describe('TAG_OPTION_KEY', () => {
  it('is the reserved key string', () => {
    assert.equal(TAG_OPTION_KEY, '__jsailsTags');
  });
});
