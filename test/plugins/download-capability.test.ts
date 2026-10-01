import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveDownloadsCapability } from '../../src/plugins/download-capability.js';

describe('resolveDownloadsCapability', () => {
  it('disables downloads during static export regardless of configuration', () => {
    assert.deepEqual(resolveDownloadsCapability({ configured: true, staticExport: true }), {
      enabled: false,
      reason: 'downloads are unavailable during static export',
    });
    assert.deepEqual(resolveDownloadsCapability({ configured: false, staticExport: true }), {
      enabled: false,
      reason: 'downloads are unavailable during static export',
    });
  });

  it('disables downloads when explicitly configured off', () => {
    assert.deepEqual(resolveDownloadsCapability({ configured: false, staticExport: false }), {
      enabled: false,
      reason: 'downloads are disabled by configuration',
    });
  });

  it('enables downloads when explicitly configured on', () => {
    assert.deepEqual(resolveDownloadsCapability({ configured: true, staticExport: false }), {
      enabled: true,
    });
  });

  it('enables downloads when configuration is omitted', () => {
    assert.deepEqual(resolveDownloadsCapability({ staticExport: false }), {
      enabled: true,
    });
  });

  it('enables downloads when configuration is null', () => {
    assert.deepEqual(resolveDownloadsCapability({ configured: null, staticExport: false }), {
      enabled: true,
    });
  });
});
