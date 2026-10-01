/**
 * Deployment shape: the `needsLive` plugin declaration and the `shape` preset
 * filter (a `static` shape drops live-only plugins).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTestApp } from '../../src/testing/index.js';
import { defineDeclarativePlugin } from '../../src/extensions/declarative-plugin.js';

describe('plugin needsLive declaration', () => {
  it('is absent (both) by default and true for live-only plugins', () => {
    const both = defineDeclarativePlugin({ name: 'both', setup: () => {} });
    const live = defineDeclarativePlugin({
      name: 'live',
      describe: () => ({ needsLive: true }),
      setup: () => {},
    });
    assert.equal(both.describe?.().needsLive, undefined);
    assert.equal(live.describe?.().needsLive, true);
  });
});

describe('shape preset', () => {
  it('a static shape excludes a needsLive plugin from setup', async () => {
    const runs: string[] = [];
    const live = defineDeclarativePlugin({
      name: 'live',
      describe: () => ({ needsLive: true }),
      setup: () => {
        runs.push('live');
      },
    });
    const contentPlug = defineDeclarativePlugin({
      name: 'content',
      setup: () => {
        runs.push('content');
      },
    });

    await createTestApp({
      config: {
        rootDir: '.',
        shape: 'static',
        extensions: [live, contentPlug],
      },
    });

    // The static shape drops the live plugin; the both-plugin still runs.
    assert.deepEqual(runs, ['content']);
  });

  it('a full shape runs both live and both plugins', async () => {
    const runs: string[] = [];
    const live = defineDeclarativePlugin({
      name: 'live',
      describe: () => ({ needsLive: true }),
      setup: () => {
        runs.push('live');
      },
    });
    const contentPlug = defineDeclarativePlugin({
      name: 'content',
      setup: () => {
        runs.push('content');
      },
    });

    await createTestApp({
      config: { rootDir: '.', extensions: [live, contentPlug] },
    });

    assert.deepEqual(runs.sort(), ['content', 'live']);
  });
});
