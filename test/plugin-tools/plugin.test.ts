/**
 * Plugin-tools plugin tests: service wiring through the extension runner,
 * plugin identity/priority, token provision, tool coverage, and idempotent
 * close. No connection, database, or external service is opened.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { z } from 'zod';

import { runExtensions } from '../../src/extensions/index.js';
import {
  pluginToolsPlugin,
  pluginToolsToken,
  type PluginTools,
} from '../../src/plugin-tools/index.js';

describe('pluginToolsPlugin identity', () => {
  it('has name "plugin-tools" and priority -1000', () => {
    const plugin = pluginToolsPlugin();
    assert.equal(plugin.name, 'plugin-tools');
    assert.equal(plugin.priority, -1000);
  });

  it('has a stable token name', () => {
    assert.equal(pluginToolsToken.name, 'plugin-tools');
  });

  it('constructing the plugin performs no I/O', () => {
    const plugin = pluginToolsPlugin();
    assert.equal(typeof plugin.name, 'string');
    assert.equal(typeof plugin.setup, 'function');
  });
});

describe('pluginToolsPlugin service provision', () => {
  it('provides PluginTools under the token', async () => {
    const runtime = await runExtensions([pluginToolsPlugin()]);
    try {
      const tools: PluginTools = runtime.services.get(pluginToolsToken);
      assert.ok(tools !== null && typeof tools === 'object');

      // Every tool category is present.
      assert.equal(typeof tools.cleanup, 'function');
      assert.equal(typeof tools.zod, 'function');
      assert.equal(typeof tools.trustedMutation, 'object');
      assert.equal(typeof tools.trustedMutation.isSameOriginRequest, 'function');
      assert.equal(typeof tools.trustedMutation.csrfTokenValid, 'function');
      assert.equal(typeof tools.trustedMutation.checkTrustedMutation, 'function');
      assert.equal(typeof tools.responses, 'object');
      assert.equal(typeof tools.responses.forbiddenResponse, 'function');
      assert.equal(typeof tools.responses.badRequestResponse, 'function');
      assert.equal(typeof tools.responses.notFoundResponse, 'function');
      assert.equal(typeof tools.responses.attachNoStore, 'function');
    } finally {
      await runtime.close();
    }
  });
});

describe('createCleanup through the service', () => {
  it('runs the teardown exactly once', async () => {
    let calls = 0;
    const runtime = await runExtensions([pluginToolsPlugin()]);
    try {
      const tools = runtime.services.get<PluginTools>(pluginToolsToken);
      const cleanup = tools.cleanup(() => {
        calls++;
      });

      await cleanup();
      assert.equal(calls, 1);

      // Second call is a no-op — the promise is memoized.
      await cleanup();
      assert.equal(calls, 1);
    } finally {
      await runtime.close();
    }
  });

  it('memoizes a rejected teardown', async () => {
    const runtime = await runExtensions([pluginToolsPlugin()]);
    try {
      const tools = runtime.services.get<PluginTools>(pluginToolsToken);
      const cleanup = tools.cleanup(() => {
        throw new Error('boom');
      });

      await assert.rejects(cleanup, /boom/);
      // Second call returns the same rejection.
      await assert.rejects(cleanup, /boom/);
    } finally {
      await runtime.close();
    }
  });
});

describe('mapZodIssues through the service', () => {
  it('maps a required-field error to a value-free entry', async () => {
    const runtime = await runExtensions([pluginToolsPlugin()]);
    try {
      const tools = runtime.services.get<PluginTools>(pluginToolsToken);

      // Simulate a Zod issue for a missing required field.
      const entries = tools.zod([
        {
          code: 'invalid_type',
          expected: 'string',
          path: ['email'],
          message: 'Required',
        },
      ] as readonly z.ZodIssue[]);

      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.path, 'email');
      assert.equal(entries[0]!.code, 'invalid_type');
    } finally {
      await runtime.close();
    }
  });
});

describe('checkTrustedMutation through the service', () => {
  it('allows a session-less request', async () => {
    const runtime = await runExtensions([pluginToolsPlugin()]);
    try {
      const tools = runtime.services.get<PluginTools>(pluginToolsToken);
      const request = new Request('http://localhost/');
      const result = tools.trustedMutation.checkTrustedMutation(request, null);

      assert.equal(result.allowed, true);
    } finally {
      await runtime.close();
    }
  });

  it('denies a cross-origin request', async () => {
    const runtime = await runExtensions([pluginToolsPlugin()]);
    try {
      const tools = runtime.services.get<PluginTools>(pluginToolsToken);
      const request = new Request('http://localhost/', {
        headers: { origin: 'https://evil.com' },
      });
      const session = { id: 's1', csrfToken: 't', userId: null, data: {}, expiresAt: 0 };

      const result = tools.trustedMutation.checkTrustedMutation(request, session, {
        expectedOrigin: 'http://localhost',
      });

      assert.equal(result.allowed, false);
      if (!result.allowed) {
        assert.equal(result.code, 'origin_mismatch');
        assert.equal(result.status, 403);
      }
    } finally {
      await runtime.close();
    }
  });
});

describe('response factories through the service', () => {
  it('forbiddenResponse returns a 403', async () => {
    const runtime = await runExtensions([pluginToolsPlugin()]);
    try {
      const tools = runtime.services.get<PluginTools>(pluginToolsToken);
      const res = tools.responses.forbiddenResponse();
      assert.equal(res.status, 403);
      assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
    } finally {
      await runtime.close();
    }
  });

  it('attachNoStore adds Cache-Control: no-store', async () => {
    const runtime = await runExtensions([pluginToolsPlugin()]);
    try {
      const tools = runtime.services.get<PluginTools>(pluginToolsToken);
      const original = new Response('ok', { status: 200 });
      const noStore = tools.responses.attachNoStore(original);

      assert.equal(noStore.status, 200);
      assert.equal(noStore.headers.get('cache-control'), 'no-store');
    } finally {
      await runtime.close();
    }
  });
});

describe('idempotent close', () => {
  it('closes idempotently with no handles held', async () => {
    const runtime = await runExtensions([pluginToolsPlugin()]);
    await runtime.close();
    await runtime.close();
  });
});
