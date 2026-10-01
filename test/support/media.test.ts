import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Media,
  MediaError,
  detect,
  extension,
  imageSizeOf,
  mimeOf,
} from '../../src/support/media.server.js';

// 1x1 transparent PNG.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('Media', () => {
  it('maps an extension to a MIME type', () => {
    assert.equal(mimeOf('png'), 'image/png');
    assert.equal(mimeOf('file.json'), 'application/json');
  });

  it('returns false for an unknown extension', () => {
    assert.equal(mimeOf('file.unknownext'), false);
  });

  it('maps a MIME type to an extension', () => {
    assert.equal(extension('image/png'), 'png');
    assert.equal(extension('application/json'), 'json');
  });

  it('returns false for an unknown MIME type', () => {
    assert.equal(extension('application/x-nonsense'), false);
  });

  it('sniffs a PNG buffer', async () => {
    const result = await detect(PNG_1X1);
    assert.ok(result);
    assert.equal(result.mime, 'image/png');
    assert.equal(result.extension, 'png');
  });

  it('returns undefined for an unrecognized buffer', async () => {
    assert.equal(await detect(Buffer.from('not a known format')), undefined);
  });

  it('throws invalid_argument for a non-buffer', async () => {
    await assert.rejects(
      // Cast through unknown to exercise the runtime guard.
      () => detect('string' as unknown as Uint8Array),
      (error: unknown) => {
        assert.ok(error instanceof MediaError);
        assert.equal(error.code, 'invalid_argument');
        return true;
      },
    );
  });

  it('reads image dimensions', () => {
    const size = imageSizeOf(PNG_1X1);
    assert.ok(size);
    assert.equal(size.width, 1);
    assert.equal(size.height, 1);
    assert.equal(size.type, 'png');
  });

  it('returns undefined for a non-image buffer', () => {
    assert.equal(imageSizeOf(Buffer.from('garbage bytes here')), undefined);
  });

  it('exposes a frozen namespace with the same functions', () => {
    assert.equal(Media.mime, mimeOf);
    assert.equal(Media.detect, detect);
    assert.ok(Object.isFrozen(Media));
  });
});
