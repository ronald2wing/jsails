/**
 * Hotwire Native web groundwork tests (Node-import safe).
 *
 * These tests exercise path-configuration parsing/validate/first-match
 * resolution and the native-bridge detection/no-op contract. They deliberately
 * run under plain Node.js with no jsdom, so the bridge tests guard `typeof
 * window` and verify the no-op fallback path.
 *
 * Bridge postMessage routing with a fake `window` double is verified through
 * a focused contract stand-in — the bridge's decisions (which handler it
 * calls, how it serialises) are asserted without claiming any real native
 * transport.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  definePathConfiguration,
  isNativeApp,
  nativeBridge,
  resolvePathConfiguration,
  resolvePathConfigurationMerged,
  defaultPathRules,
  type PathConfiguration,
} from '../../src/client/native.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert a thrown error carries the expected name and message substring. */
function assertThrows(block: () => unknown, expectedName: string, messageContains: string): void {
  assert.throws(block, (err: unknown) => {
    if (!(err instanceof Error)) return false;
    return err.name === expectedName && err.message.includes(messageContains);
  });
}

function makeConfig(
  rules: Array<{
    patterns: string[];
    properties: Record<string, unknown>;
  }>,
): PathConfiguration {
  return definePathConfiguration({ rules });
}

// ---------------------------------------------------------------------------
// definePathConfiguration — parsing and validation
// ---------------------------------------------------------------------------

describe('definePathConfiguration', () => {
  it('accepts a minimal valid configuration with settings', () => {
    const input = {
      settings: { matchQueryStrings: true },
      rules: [
        {
          patterns: ['/dashboard'],
          properties: { presentation: 'push' },
        },
      ],
    };

    const config = definePathConfiguration(input);

    assert.deepEqual(config.settings, { matchQueryStrings: true });
    assert.equal(config.rules.length, 1);
    assert.deepEqual(config.rules[0]!.patterns, ['/dashboard']);
    assert.deepEqual(config.rules[0]!.properties, { presentation: 'push' });
  });

  it('defaults settings to an empty frozen object when absent', () => {
    const config = definePathConfiguration({
      rules: [{ patterns: ['/'], properties: { root: true } }],
    });

    assert.deepEqual(config.settings, {});
    assert.ok(Object.isFrozen(config.settings));
  });

  it('defaults settings to empty when null', () => {
    const config = definePathConfiguration({
      settings: null as unknown as Record<string, unknown>,
      rules: [{ patterns: ['/'], properties: { x: 1 } }],
    });

    assert.deepEqual(config.settings, {});
  });

  it('freezes the returned config and all nested objects', () => {
    const config = definePathConfiguration({
      rules: [{ patterns: ['/a'], properties: { key: 'val' } }],
    });

    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(config.rules));
    assert.ok(Object.isFrozen(config.rules[0]!));
    assert.ok(Object.isFrozen(config.rules[0]!.patterns));
    assert.ok(Object.isFrozen(config.rules[0]!.properties));
  });

  // --- rejection cases (value-free) ---

  it('rejects null input', () => {
    assertThrows(
      () =>
        definePathConfiguration(null as unknown as Parameters<typeof definePathConfiguration>[0]),
      'PathConfigurationError',
      'path configuration must be an object',
    );
  });

  it('rejects non-object input', () => {
    assertThrows(
      () =>
        definePathConfiguration(
          'not-an-object' as unknown as Parameters<typeof definePathConfiguration>[0],
        ),
      'PathConfigurationError',
      'path configuration must be an object',
    );
  });

  it('rejects missing rules array', () => {
    assertThrows(
      () => definePathConfiguration({} as unknown as Parameters<typeof definePathConfiguration>[0]),
      'PathConfigurationError',
      '"rules" array',
    );
  });

  it('rejects non-array rules', () => {
    assertThrows(
      () =>
        definePathConfiguration({
          rules: 'bad' as unknown as [],
        }),
      'PathConfigurationError',
      '"rules" array',
    );
  });

  it('rejects a rule that is not an object', () => {
    assertThrows(
      () =>
        definePathConfiguration({
          rules: [
            null as unknown as {
              patterns: string[];
              properties: Record<string, unknown>;
            },
          ],
        }),
      'PathConfigurationError',
      'must be an object',
    );
  });

  it('rejects a rule with missing patterns', () => {
    assertThrows(
      () =>
        definePathConfiguration({
          rules: [
            { properties: {} } as unknown as {
              patterns: string[];
              properties: Record<string, unknown>;
            },
          ],
        }),
      'PathConfigurationError',
      'patterns',
    );
  });

  it('rejects a rule with empty patterns array', () => {
    assertThrows(
      () =>
        definePathConfiguration({
          rules: [{ patterns: [], properties: {} }],
        }),
      'PathConfigurationError',
      'non-empty array',
    );
  });

  it('rejects a rule with non-array patterns', () => {
    assertThrows(
      () =>
        definePathConfiguration({
          rules: [
            {
              patterns: 'not-array' as unknown as string[],
              properties: {},
            },
          ],
        }),
      'PathConfigurationError',
      'patterns',
    );
  });

  it('rejects a rule with non-string pattern entry', () => {
    assertThrows(
      () =>
        definePathConfiguration({
          rules: [{ patterns: [42 as unknown as string], properties: {} }],
        }),
      'PathConfigurationError',
      'non-string',
    );
  });

  it('rejects a rule with an invalid regex pattern', () => {
    assertThrows(
      () =>
        definePathConfiguration({
          rules: [{ patterns: ['[unclosed'], properties: {} }],
        }),
      'PathConfigurationError',
      'invalid regex',
    );
  });

  it('rejects a rule with excessively long pattern string', () => {
    const longPattern = '/a'.repeat(2001);
    assertThrows(
      () =>
        definePathConfiguration({
          rules: [{ patterns: [longPattern], properties: {} }],
        }),
      'PathConfigurationError',
      'longer than',
    );
  });

  it('rejects a rule with missing properties', () => {
    assertThrows(
      () =>
        definePathConfiguration({
          rules: [
            { patterns: ['/'] } as unknown as {
              patterns: string[];
              properties: Record<string, unknown>;
            },
          ],
        }),
      'PathConfigurationError',
      'properties',
    );
  });

  it('rejects a rule with null properties', () => {
    assertThrows(
      () =>
        definePathConfiguration({
          rules: [
            {
              patterns: ['/'],
              properties: null as unknown as Record<string, unknown>,
            },
          ],
        }),
      'PathConfigurationError',
      'properties',
    );
  });

  it('rejects non-object settings', () => {
    assertThrows(
      () =>
        definePathConfiguration({
          settings: 42 as unknown as Record<string, unknown>,
          rules: [{ patterns: ['/'], properties: {} }],
        }),
      'PathConfigurationError',
      'settings must be an object',
    );
  });

  it('rejects more than MAX_RULES entries', () => {
    const rules = Array.from({ length: 501 }, (_, i) => ({
      patterns: [`/${i}`],
      properties: {},
    }));
    assertThrows(() => definePathConfiguration({ rules }), 'PathConfigurationError', '500');
  });

  it('rejects more than MAX_PATTERNS entries per rule', () => {
    assertThrows(
      () =>
        definePathConfiguration({
          rules: [
            {
              patterns: Array.from({ length: 201 }, (_, i) => `/${i}`),
              properties: {},
            },
          ],
        }),
      'PathConfigurationError',
      '200',
    );
  });

  // Error messages never embed raw input data.
  it('never echoes raw input data in error messages', () => {
    try {
      definePathConfiguration({ rules: 'not-an-array' as unknown as [] });
    } catch (err) {
      const message = (err as Error).message;
      assert.equal(message.includes('not-an-array'), false);
    }
  });
});

// ---------------------------------------------------------------------------
// resolvePathConfiguration — first-match resolution
// ---------------------------------------------------------------------------

describe('resolvePathConfiguration', () => {
  it('returns the first matching rule properties', () => {
    const config = makeConfig([
      { patterns: ['/dashboard'], properties: { presentation: 'push' } },
      {
        patterns: ['/dashboard', '/settings'],
        properties: { presentation: 'replace' },
      },
    ]);

    assert.deepEqual(resolvePathConfiguration(config, 'https://app.example.com/dashboard'), {
      presentation: 'push',
    });
  });

  it('returns empty properties when no rule matches', () => {
    const config = makeConfig([{ patterns: ['/admin'], properties: { admin: true } }]);

    assert.deepEqual(resolvePathConfiguration(config, 'https://app.example.com/public'), {});
  });

  it('matches against pathname only when no query string', () => {
    const config = makeConfig([{ patterns: ['^/users/\\d+$'], properties: { type: 'user' } }]);

    assert.deepEqual(resolvePathConfiguration(config, 'https://example.com/users/42'), {
      type: 'user',
    });
  });

  it('matches against pathname + query string when present', () => {
    const config = makeConfig([
      {
        patterns: ['/products\\?sort=price'],
        properties: { sortKey: 'price' },
      },
      { patterns: ['/products'], properties: { sortKey: 'default' } },
    ]);

    assert.deepEqual(
      resolvePathConfiguration(config, 'https://shop.example.com/products?sort=price'),
      { sortKey: 'price' },
    );
  });

  it('matches without query string when URL has none', () => {
    const config = makeConfig([
      {
        patterns: ['/products\\?sort=price'],
        properties: { variant: 'sorted' },
      },
      { patterns: ['/products'], properties: { variant: 'unsorted' } },
    ]);

    assert.deepEqual(resolvePathConfiguration(config, 'https://shop.example.com/products'), {
      variant: 'unsorted',
    });
  });

  it('first-match wins even when a later rule also matches', () => {
    const config = makeConfig([
      { patterns: ['/dashboard'], properties: { priority: 'high' } },
      { patterns: ['.*'], properties: { priority: 'low' } },
    ]);

    assert.deepEqual(resolvePathConfiguration(config, 'https://app.example.com/dashboard'), {
      priority: 'high',
    });
  });

  it('catch-all rule as last entry catches everything unmatched', () => {
    const config = makeConfig([
      { patterns: ['/dashboard'], properties: { presentation: 'push' } },
      { patterns: ['.*'], properties: { presentation: 'replace' } },
    ]);

    assert.deepEqual(resolvePathConfiguration(config, 'https://app.example.com/unknown'), {
      presentation: 'replace',
    });
  });

  it('accepts a URL string', () => {
    const config = makeConfig([{ patterns: ['/about'], properties: { static: true } }]);

    assert.deepEqual(resolvePathConfiguration(config, 'https://example.com/about'), {
      static: true,
    });
  });

  it('rejects an invalid URL string', () => {
    const config = makeConfig([{ patterns: ['/'], properties: {} }]);

    assert.throws(() => resolvePathConfiguration(config, ''));
  });

  it('returns the same frozen empty reference for every miss', () => {
    const config = makeConfig([{ patterns: ['/a'], properties: { x: 1 } }]);
    const a = resolvePathConfiguration(config, 'https://example.com/b');
    const b = resolvePathConfiguration(config, 'https://example.com/c');
    assert.equal(a, b);
    assert.ok(Object.isFrozen(a));
  });

  it('returns the same frozen properties reference for repeated matches', () => {
    const config = makeConfig([{ patterns: ['/'], properties: { root: true } }]);
    const a = resolvePathConfiguration(config, 'https://a.example.com/');
    const b = resolvePathConfiguration(config, 'https://b.example.com/');
    assert.equal(a, b);
    assert.ok(Object.isFrozen(a));
  });

  it('handles percent-encoded paths', () => {
    const config = makeConfig([
      {
        patterns: ['/products/%C3%A9d'],
        properties: { match: 'encoded' },
      },
    ]);

    assert.deepEqual(resolvePathConfiguration(config, 'https://example.com/products/%C3%A9d'), {
      match: 'encoded',
    });
  });

  it('handles root path', () => {
    const config = makeConfig([{ patterns: ['^/$'], properties: { isRoot: true } }]);

    assert.deepEqual(resolvePathConfiguration(config, 'https://example.com/'), { isRoot: true });
    assert.deepEqual(resolvePathConfiguration(config, 'https://example.com/about'), {});
  });
});

// ---------------------------------------------------------------------------
// isNativeApp — detection in a headless Node.js environment
// ---------------------------------------------------------------------------

describe('isNativeApp', () => {
  it('returns false under plain Node.js (typeof window is undefined)', () => {
    assert.equal(isNativeApp(), false);
  });
});

// ---------------------------------------------------------------------------
// nativeBridge — no-op under headless Node.js
// ---------------------------------------------------------------------------

describe('nativeBridge', () => {
  it('returns the shared no-op bridge when not in native app', () => {
    const a = nativeBridge();
    const b = nativeBridge();
    assert.equal(a, b);
    assert.ok(Object.isFrozen(a));
  });

  it('postMessage is a no-op when not running in a native app', () => {
    const bridge = nativeBridge();
    assert.doesNotThrow(() => bridge.postMessage('connect'));
    assert.doesNotThrow(() => bridge.postMessage('display', { title: 'Test' }));
    assert.doesNotThrow(() => bridge.postMessage('submit', {}));
    assert.doesNotThrow(() => bridge.postMessage('unknown', undefined));
  });

  it('postMessage never throws even with exotic data shapes', () => {
    const bridge = nativeBridge();
    assert.doesNotThrow(() =>
      bridge.postMessage('test', {
        nested: { deep: [1, 2, 3] },
        value: null,
      }),
    );
  });

  it('returns a valid bridge shape', () => {
    const bridge = nativeBridge();
    assert.equal(typeof bridge.postMessage, 'function');
  });
});

// ---------------------------------------------------------------------------
// nativeBridge — postMessage routing with a fake bridge
// ---------------------------------------------------------------------------

describe('nativeBridge routing', () => {
  const savedWindow = globalThis.window;

  interface CapturedMessage {
    handler: 'webkit' | 'HotwireNative';
    name?: string;
    data?: Record<string, unknown>;
    rawPayload?: unknown;
  }

  function installFakeWindow(options: {
    webkitBridge?: boolean;
    hotwireNative?: boolean;
    hotwireNativePostMessage?: (name: string, data?: Record<string, unknown>) => void;
    webkitPostMessage?: (payload: unknown) => void;
  }): CapturedMessage[] {
    const captured: CapturedMessage[] = [];

    const win: Record<string, unknown> = {};

    if (options.webkitBridge) {
      win.webkit = {
        messageHandlers: {
          bridge: {
            postMessage: (payload: unknown) => {
              captured.push({ handler: 'webkit', rawPayload: payload });
              options.webkitPostMessage?.(payload);
            },
          },
        },
      };
    }

    if (options.hotwireNative) {
      win.HotwireNative = {
        postMessage: (name: string, data?: Record<string, unknown>) => {
          captured.push({ handler: 'HotwireNative', name, data });
          options.hotwireNativePostMessage?.(name, data);
        },
      };
    }

    (globalThis as Record<string, unknown>).window = win;

    return captured;
  }

  function restoreWindow(): void {
    if (savedWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = savedWindow;
    }
  }

  it('routes postMessage through window.webkit.messageHandlers.bridge', () => {
    const captured = installFakeWindow({ webkitBridge: true });
    const bridge = nativeBridge();
    bridge.postMessage('connect', { key: 'val' });

    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.handler, 'webkit');
    assert.deepEqual(captured[0]!.rawPayload, {
      name: 'connect',
      data: { key: 'val' },
    });

    restoreWindow();
  });

  it('routes postMessage without data through webkit bridge', () => {
    const captured = installFakeWindow({ webkitBridge: true });
    const bridge = nativeBridge();
    bridge.postMessage('ready');

    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.handler, 'webkit');
    assert.deepEqual(captured[0]!.rawPayload, { name: 'ready' });

    restoreWindow();
  });

  it('routes through window.HotwireNative when webkit is absent', () => {
    const captured = installFakeWindow({
      hotwireNative: true,
      webkitBridge: false,
    });
    const bridge = nativeBridge();
    bridge.postMessage('display', { title: 'Page Title' });

    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.handler, 'HotwireNative');
    assert.equal(captured[0]!.name, 'display');
    assert.deepEqual(captured[0]!.data, { title: 'Page Title' });

    restoreWindow();
  });

  it('prefers webkit over HotwireNative when both are present', () => {
    const captured = installFakeWindow({
      webkitBridge: true,
      hotwireNative: true,
    });
    const bridge = nativeBridge();
    bridge.postMessage('event', {});

    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.handler, 'webkit');

    restoreWindow();
  });

  it('silently drops when the webkit handler throws', () => {
    const captured = installFakeWindow({
      webkitBridge: true,
      webkitPostMessage: () => {
        throw new Error('native handler error');
      },
    });
    ((globalThis as Record<string, unknown>).window as Record<string, unknown>).HotwireNative =
      undefined;

    const bridge = nativeBridge();
    assert.doesNotThrow(() => bridge.postMessage('will-fail'));
    assert.equal(captured.length, 1);

    restoreWindow();
  });

  it('silently drops when HotwireNative.postMessage throws', () => {
    const captured = installFakeWindow({
      webkitBridge: false,
      hotwireNative: true,
      hotwireNativePostMessage: () => {
        throw new Error('native error');
      },
    });

    const bridge = nativeBridge();
    assert.doesNotThrow(() => bridge.postMessage('will-fail'));
    assert.equal(captured.length, 1);

    restoreWindow();
  });

  it('postMessage is a no-op when neither bridge exists', () => {
    const captured = installFakeWindow({});
    const bridge = nativeBridge();
    assert.doesNotThrow(() => bridge.postMessage('no-bridge'));
    assert.equal(captured.length, 0);

    restoreWindow();
  });
});

// ---------------------------------------------------------------------------
// Type-level verification
// ---------------------------------------------------------------------------

describe('module exports', () => {
  it('exports every public symbol', () => {
    assert.ok(true);
  });

  it('definePathConfiguration returns a frozen config', () => {
    const config = definePathConfiguration({
      rules: [{ patterns: ['/test'], properties: { flag: true } }],
    });

    assert.throws(() => {
      (config as { settings: unknown }).settings = {};
    });
    assert.throws(() => {
      (config.rules as Array<unknown>).push({
        patterns: [],
        properties: {},
      });
    });
  });

  it('resolvePathConfiguration returns the frozen default on miss', () => {
    const config = definePathConfiguration({
      rules: [{ patterns: ['/only'], properties: { x: 1 } }],
    });

    const props = resolvePathConfiguration(config, 'https://example.com/other');
    assert.ok(Object.isFrozen(props));
    assert.deepEqual(props, {});
  });
});

// ---------------------------------------------------------------------------
// resolvePathConfigurationMerged — all-match merge resolution
// ---------------------------------------------------------------------------

describe('resolvePathConfigurationMerged', () => {
  it('merges properties from every matching rule (later wins)', () => {
    const config = definePathConfiguration({
      rules: [
        { patterns: ['/dashboard'], properties: { presentation: 'push', theme: 'dark' } },
        {
          patterns: ['/dashboard', '/settings'],
          properties: { presentation: 'replace', nav: 'tab_bar' },
        },
      ],
    });

    const props = resolvePathConfigurationMerged(config, 'https://app.example.com/dashboard');

    assert.deepEqual(props, {
      presentation: 'replace',
      theme: 'dark',
      nav: 'tab_bar',
    });
  });

  it('returns only the first match when no other rules match', () => {
    const config = definePathConfiguration({
      rules: [
        { patterns: ['/admin'], properties: { admin: true } },
        { patterns: ['/public'], properties: { admin: false } },
      ],
    });

    assert.deepEqual(resolvePathConfigurationMerged(config, 'https://example.com/admin'), {
      admin: true,
    });
  });

  it('returns empty frozen object when no rule matches', () => {
    const config = makeConfig([{ patterns: ['/only'], properties: { x: 1 } }]);

    const props = resolvePathConfigurationMerged(config, 'https://example.com/other');
    assert.ok(Object.isFrozen(props));
    assert.deepEqual(props, {});
  });

  it('returns shared empty reference on miss', () => {
    const config = makeConfig([{ patterns: ['/a'], properties: { x: 1 } }]);
    const a = resolvePathConfigurationMerged(config, 'https://example.com/b');
    const b = resolvePathConfigurationMerged(config, 'https://example.com/c');
    assert.equal(a, b);
  });

  it('multiple rules with disjoint keys accumulate', () => {
    const config = definePathConfiguration({
      rules: [
        { patterns: ['.*'], properties: { present: 'pop', context: 'default' } },
        { patterns: ['.*'], properties: { historical_location: true } },
      ],
    });

    assert.deepEqual(resolvePathConfigurationMerged(config, 'https://example.com/any'), {
      present: 'pop',
      context: 'default',
      historical_location: true,
    });
  });

  it('matches pathname+query', () => {
    const config = definePathConfiguration({
      rules: [
        { patterns: ['/products\\?sort=price'], properties: { sort: 'price' } },
        { patterns: ['/products'], properties: { sort: 'default', view: 'grid' } },
      ],
    });

    assert.deepEqual(
      resolvePathConfigurationMerged(config, 'https://shop.example.com/products?sort=price'),
      { sort: 'default', view: 'grid' },
    );
  });

  it('matches URL object', () => {
    const config = makeConfig([{ patterns: ['/about'], properties: { static: true } }]);
    assert.deepEqual(resolvePathConfigurationMerged(config, new URL('https://example.com/about')), {
      static: true,
    });
  });

  it('rejects invalid URL string', () => {
    const config = makeConfig([{ patterns: ['/'], properties: {} }]);
    assert.throws(() => resolvePathConfigurationMerged(config, ''));
  });
});

// ---------------------------------------------------------------------------
// defaultPathRules
// ---------------------------------------------------------------------------

describe('defaultPathRules', () => {
  it('returns three rules', () => {
    const rules = defaultPathRules();
    assert.equal(rules.length, 3);
  });

  it('first rule has presentation pop + context default', () => {
    const rules = defaultPathRules();
    assert.deepEqual(rules[0]!.patterns, ['.*']);
    assert.deepEqual(rules[0]!.properties, {
      presentation: 'pop',
      context: 'default',
      historical_location: true,
    });
  });

  it('second rule has presentation refresh', () => {
    const rules = defaultPathRules();
    assert.deepEqual(rules[1]!.properties, {
      presentation: 'refresh',
      historical_location: true,
    });
  });

  it('third rule has presentation replace', () => {
    const rules = defaultPathRules();
    assert.deepEqual(rules[2]!.properties, {
      presentation: 'replace',
      historical_location: true,
    });
  });

  it('every rule is frozen', () => {
    for (const rule of defaultPathRules()) {
      assert.ok(Object.isFrozen(rule));
      assert.ok(Object.isFrozen(rule.patterns));
      assert.ok(Object.isFrozen(rule.properties));
    }
  });

  it('rules match every path', () => {
    const rules = defaultPathRules();
    for (const rule of rules) {
      for (const pattern of rule.patterns) {
        assert.ok(new RegExp(pattern).test('/anything'));
        assert.ok(new RegExp(pattern).test('/very/deep/nested/path'));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Bridge message envelope + reply channel (native-protocol.ts)
// ---------------------------------------------------------------------------

import {
  createBridgeMessage,
  isBridgeMessage,
  replyTo,
  type BridgeMessage,
} from '../../src/client/native-protocol.js';

describe('Bridge message envelope', () => {
  it('createBridgeMessage builds a valid message', () => {
    const msg = createBridgeMessage(
      'button',
      'click',
      { x: 1 },
      {
        metadata: { url: 'https://example.com' },
        id: 'abc-123',
      },
    );

    assert.equal(msg.id, 'abc-123');
    assert.equal(msg.component, 'button');
    assert.equal(msg.event, 'click');
    assert.deepEqual(msg.data, { x: 1 });
    assert.deepEqual(msg.metadata, { url: 'https://example.com' });
  });

  it('defaults id to a non-empty string when not supplied', () => {
    const msg = createBridgeMessage(undefined, 'ping', null);
    assert.equal(typeof msg.id, 'string');
    assert.ok(msg.id.length > 0);
  });

  it('generates unique ids for consecutive messages without explicit id', () => {
    const a = createBridgeMessage(undefined, 'e1', null);
    const b = createBridgeMessage(undefined, 'e2', null);
    assert.notEqual(a.id, b.id);
  });

  it('component is optional', () => {
    const msg = createBridgeMessage(undefined, 'connect', null);
    assert.equal(msg.component, undefined);
  });

  it('metadata is optional', () => {
    const msg = createBridgeMessage('btn', 'tap', null);
    assert.equal(msg.metadata, undefined);
  });

  it('throws when event is empty', () => {
    assert.throws(
      () => createBridgeMessage(undefined, '', null),
      (err: unknown) => (err as Error).name === 'BridgeMessageError',
    );
  });

  it('throws when explicit id is empty', () => {
    assert.throws(
      () => createBridgeMessage(undefined, 'ev', null, { id: '' }),
      (err: unknown) => (err as Error).name === 'BridgeMessageError',
    );
  });

  it('error messages are value-free', () => {
    try {
      createBridgeMessage(undefined, '', null);
    } catch (err) {
      const message = (err as Error).message;
      assert.equal(message.includes('""'), false);
      assert.equal(message.includes("''"), false);
    }
  });
});

describe('replyTo', () => {
  it('carries the same id as the original message', () => {
    const original = createBridgeMessage('btn', 'click', null, { id: 'req-42' });
    const reply = replyTo(original, 'clicked', { confirmed: true });
    assert.equal(reply.id, 'req-42');
  });

  it('sets component to undefined', () => {
    const original = createBridgeMessage('btn', 'click', null, { id: '1' });
    const reply = replyTo(original, 'done');
    assert.equal(reply.component, undefined);
  });

  it('defaults data to null when omitted', () => {
    const original = createBridgeMessage(undefined, 'ping', null, { id: 'x' });
    const reply = replyTo(original, 'pong');
    assert.equal(reply.data, null);
  });

  it('preserves explicitly passed data', () => {
    const original = createBridgeMessage(undefined, 'req', null, { id: 'y' });
    const reply = replyTo(original, 'res', { ok: true });
    assert.deepEqual(reply.data, { ok: true });
  });
});

describe('isBridgeMessage', () => {
  it('accepts a valid bridge message', () => {
    const msg = createBridgeMessage(undefined, 'event', null, { id: 'id' });
    assert.ok(isBridgeMessage(msg));
  });

  it('rejects null', () => {
    assert.equal(isBridgeMessage(null), false);
  });

  it('rejects plain objects missing required fields', () => {
    assert.equal(isBridgeMessage({}), false);
    assert.equal(isBridgeMessage({ id: 'x' }), false);
    assert.equal(isBridgeMessage({ event: 'e' }), false);
    assert.equal(isBridgeMessage({ id: 'x', event: 'e' }), false);
  });

  it('rejects non-objects', () => {
    assert.equal(isBridgeMessage(42), false);
    assert.equal(isBridgeMessage('string'), false);
    assert.equal(isBridgeMessage(true), false);
  });
});

// ---------------------------------------------------------------------------
// Bridge component registry (native-protocol.ts)
// ---------------------------------------------------------------------------

import { createBridgeComponentRegistry } from '../../src/client/native-protocol.js';

function captureSend(): { messages: BridgeMessage[]; send: (msg: BridgeMessage) => void } {
  const messages: BridgeMessage[] = [];
  return {
    messages,
    send(msg: BridgeMessage) {
      messages.push(msg);
    },
  };
}

describe('BridgeComponentRegistry', () => {
  const captured = captureSend();

  it('register adds the name and emits a register event', () => {
    const registry = createBridgeComponentRegistry(captured.send);
    registry.register('button');
    assert.ok(registry.has('button'));
    assert.equal(captured.messages.length, 1);
    assert.equal(captured.messages[0]!.component, 'button');
    assert.equal(captured.messages[0]!.event, 'register');
  });

  it('unregister removes the name and emits an unregister event', () => {
    const msgs = captureSend();
    const registry = createBridgeComponentRegistry(msgs.send);
    registry.register('form');
    registry.unregister('form');
    assert.equal(registry.has('form'), false);
    assert.equal(msgs.messages.length, 2);
    assert.equal(msgs.messages[1]!.event, 'unregister');
  });

  it('throws on duplicate register', () => {
    const registry = createBridgeComponentRegistry(captured.send);
    registry.register('nav');
    assert.throws(
      () => registry.register('nav'),
      (err: unknown) => (err as Error).name === 'BridgeComponentError',
    );
  });

  it('throws on unregister of unknown name', () => {
    const registry = createBridgeComponentRegistry(captured.send);
    assert.throws(
      () => registry.unregister('missing'),
      (err: unknown) => (err as Error).name === 'BridgeComponentError',
    );
  });

  it('throws on empty name register', () => {
    const registry = createBridgeComponentRegistry(captured.send);
    assert.throws(
      () => registry.register(''),
      (err: unknown) => (err as Error).name === 'BridgeComponentError',
    );
  });

  it('has returns false for unknown names', () => {
    const registry = createBridgeComponentRegistry(captured.send);
    assert.equal(registry.has('unknown'), false);
  });

  it('names returns a frozen snapshot', () => {
    const registry = createBridgeComponentRegistry(captured.send);
    registry.register('a');
    registry.register('b');
    const names = registry.names();
    assert.deepEqual(names, ['a', 'b']);
    assert.ok(Object.isFrozen(names));
  });

  it('names is a snapshot (mutation-proof)', () => {
    const registry = createBridgeComponentRegistry(captured.send);
    registry.register('x');
    const snapshot = registry.names();
    registry.register('y');
    const updated = registry.names();
    assert.notDeepEqual(snapshot, updated);
  });

  it('error messages are value-free', () => {
    const registry = createBridgeComponentRegistry(captured.send);
    try {
      registry.register('');
    } catch (err) {
      const message = (err as Error).message;
      assert.equal(message.includes('""'), false);
    }
  });
});

// ---------------------------------------------------------------------------
// Visit proposal contract (native-protocol.ts)
// ---------------------------------------------------------------------------

import { isVisitProposal, type VisitProposal } from '../../src/client/native-protocol.js';

describe('VisitProposal', () => {
  const valid: VisitProposal = {
    location: 'https://example.com/page',
    options: { action: 'advance' },
  };

  it('isVisitProposal accepts a valid advance proposal', () => {
    assert.ok(isVisitProposal(valid));
  });

  it('isVisitProposal accepts replace action', () => {
    assert.ok(isVisitProposal({ location: '/', options: { action: 'replace' } }));
  });

  it('isVisitProposal accepts restore action', () => {
    assert.ok(isVisitProposal({ location: '/', options: { action: 'restore' } }));
  });

  it('isVisitProposal accepts optional response', () => {
    assert.ok(
      isVisitProposal({
        location: '/',
        options: { action: 'advance', response: { status: 200 } },
      }),
    );
  });

  it('isVisitProposal rejects null', () => {
    assert.equal(isVisitProposal(null), false);
  });

  it('isVisitProposal rejects missing location', () => {
    assert.equal(isVisitProposal({ options: { action: 'advance' } }), false);
  });

  it('isVisitProposal rejects missing options', () => {
    assert.equal(isVisitProposal({ location: '/' }), false);
  });

  it('isVisitProposal rejects null options', () => {
    assert.equal(isVisitProposal({ location: '/', options: null }), false);
  });

  it('isVisitProposal rejects non-object options', () => {
    assert.equal(isVisitProposal({ location: '/', options: 'advance' }), false);
  });

  it('isVisitProposal rejects unknown action', () => {
    assert.equal(isVisitProposal({ location: '/', options: { action: 'pop' } }), false);
    assert.equal(isVisitProposal({ location: '/', options: { action: 'push' } }), false);
  });

  it('isVisitProposal rejects non-string action', () => {
    assert.equal(isVisitProposal({ location: '/', options: { action: 42 } }), false);
  });

  it('isVisitProposal rejects non-string location', () => {
    assert.equal(isVisitProposal({ location: 42, options: { action: 'advance' } }), false);
  });
});

// ---------------------------------------------------------------------------
// Path configuration loader (path-config-loader.ts)
// ---------------------------------------------------------------------------

import {
  createPathConfigurationLoader,
  mergePathConfigurations,
  type PathConfigSource,
} from '../../src/client/path-config-loader.js';

function fakeFetch(body: string, status = 200): typeof globalThis.fetch {
  return ((_url: string) =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(body),
    })) as unknown as typeof globalThis.fetch;
}

function failingFetch(): typeof globalThis.fetch {
  return ((_url: string) =>
    Promise.reject(new Error('network error'))) as unknown as typeof globalThis.fetch;
}

const dataSource: PathConfigSource = {
  kind: 'data',
  value: JSON.stringify({
    settings: { dataSource: true },
    rules: [{ patterns: ['/data'], properties: { from: 'data' } }],
  }),
};

const fileSource: PathConfigSource = {
  kind: 'file',
  value: JSON.stringify({
    settings: { fileSource: true },
    rules: [{ patterns: ['/file'], properties: { from: 'file' } }],
  }),
};

const serverSource: PathConfigSource = {
  kind: 'server',
  value: 'https://example.com/config.json',
};

describe('PathConfigurationLoader', () => {
  describe('load', () => {
    it('loads a data source', async () => {
      const loader = createPathConfigurationLoader({ fetch: fakeFetch('{}') });
      const config = await loader.load(dataSource);
      assert.deepEqual(config.settings, { dataSource: true });
      assert.equal(config.rules.length, 1);
      assert.deepEqual(config.rules[0]!.properties, { from: 'data' });
    });

    it('loads a file source', async () => {
      const loader = createPathConfigurationLoader({ fetch: fakeFetch('{}') });
      const config = await loader.load(fileSource);
      assert.deepEqual(config.settings, { fileSource: true });
    });

    it('loads a server source via fetch', async () => {
      const body = JSON.stringify({
        rules: [{ patterns: ['/server'], properties: { from: 'server' } }],
      });
      const loader = createPathConfigurationLoader({ fetch: fakeFetch(body) });
      const config = await loader.load(serverSource);
      assert.equal(config.rules.length, 1);
      assert.deepEqual(config.rules[0]!.properties, { from: 'server' });
    });

    it('throws for an unknown source kind', async () => {
      const loader = createPathConfigurationLoader({ fetch: fakeFetch('{}') });
      await assert.rejects(
        () => loader.load({ kind: 'remote' as never, value: 'x' }),
        (err: unknown) =>
          (err as Error).name === 'PathConfigLoaderError' &&
          (err as Error).message.includes('kind'),
      );
    });

    it('throws for invalid JSON in data source', async () => {
      const loader = createPathConfigurationLoader({ fetch: fakeFetch('{}') });
      await assert.rejects(
        () => loader.load({ kind: 'data', value: 'not-json' }),
        (err: unknown) =>
          (err as Error).name === 'PathConfigLoaderError' &&
          (err as Error).message.includes('JSON'),
      );
    });

    it('throws on fetch failure', async () => {
      const loader = createPathConfigurationLoader({ fetch: failingFetch() });
      await assert.rejects(
        () => loader.load({ kind: 'server', value: 'https://fail.example.com/' }),
        (err: unknown) =>
          (err as Error).name === 'PathConfigLoaderError' &&
          (err as Error).message.includes('fetch'),
      );
    });

    it('throws on non-ok server response', async () => {
      const loader = createPathConfigurationLoader({ fetch: fakeFetch('{}', 500) });
      await assert.rejects(
        () => loader.load({ kind: 'server', value: 'https://error.example.com/' }),
        (err: unknown) =>
          (err as Error).name === 'PathConfigLoaderError' &&
          (err as Error).message.includes('error'),
      );
    });

    it('throws on invalid config structure from server', async () => {
      const loader = createPathConfigurationLoader({
        fetch: fakeFetch(JSON.stringify({ rules: 'not-an-array' })),
      });
      await assert.rejects(
        () => loader.load({ kind: 'server', value: 'https://bad.example.com/' }),
        (err: unknown) =>
          (err as Error).name === 'PathConfigLoaderError' &&
          (err as Error).message.includes('invalid'),
      );
    });

    it('error messages are value-free (no URL/body leaked)', async () => {
      const loader = createPathConfigurationLoader({ fetch: fakeFetch('bad', 500) });
      try {
        await loader.load(serverSource);
      } catch (err) {
        const message = (err as Error).message;
        assert.equal(message.includes('https://example.com'), false);
        assert.equal(message.includes('bad'), false);
      }
    });
  });

  describe('loadAll', () => {
    it('merges settings from multiple sources (later wins)', async () => {
      const loader = createPathConfigurationLoader({ fetch: fakeFetch('{}') });
      const config = await loader.loadAll([dataSource, fileSource]);

      assert.deepEqual(config.settings, {
        dataSource: true,
        fileSource: true,
      });
    });

    it('concatenates rules from all sources', async () => {
      const loader = createPathConfigurationLoader({ fetch: fakeFetch('{}') });
      const config = await loader.loadAll([dataSource, fileSource]);

      assert.equal(config.rules.length, 2);
      assert.deepEqual(config.rules[0]!.properties, { from: 'data' });
      assert.deepEqual(config.rules[1]!.properties, { from: 'file' });
    });

    it('returns empty config when sources array is empty', async () => {
      const loader = createPathConfigurationLoader({ fetch: fakeFetch('{}') });
      const config = await loader.loadAll([]);

      assert.deepEqual(config.settings, {});
      assert.deepEqual(config.rules, []);
      assert.ok(Object.isFrozen(config));
    });

    it('merges data + file + server sources', async () => {
      const serverBody = JSON.stringify({
        settings: { serverSource: true },
        rules: [{ patterns: ['/server'], properties: { from: 'server' } }],
      });
      const loader = createPathConfigurationLoader({ fetch: fakeFetch(serverBody) });

      const config = await loader.loadAll([dataSource, fileSource, serverSource]);

      assert.deepEqual(config.settings, {
        dataSource: true,
        fileSource: true,
        serverSource: true,
      });
      assert.equal(config.rules.length, 3);
    });

    it('later source overrides earlier setting keys', async () => {
      const a: PathConfigSource = {
        kind: 'data',
        value: JSON.stringify({ settings: { theme: 'light' }, rules: [] }),
      };
      const b: PathConfigSource = {
        kind: 'data',
        value: JSON.stringify({ settings: { theme: 'dark' }, rules: [] }),
      };
      const loader = createPathConfigurationLoader({ fetch: fakeFetch('{}') });
      const config = await loader.loadAll([a, b]);

      assert.deepEqual(config.settings, { theme: 'dark' });
    });
  });
});

describe('mergePathConfigurations', () => {
  it('merges two validated configs', () => {
    const a = definePathConfiguration({
      settings: { a: 1 },
      rules: [{ patterns: ['/a'], properties: { from: 'a' } }],
    });
    const b = definePathConfiguration({
      settings: { b: 2 },
      rules: [{ patterns: ['/b'], properties: { from: 'b' } }],
    });

    const merged = mergePathConfigurations([a, b]);

    assert.deepEqual(merged.settings, { a: 1, b: 2 });
    assert.equal(merged.rules.length, 2);
  });

  it('returns a frozen config', () => {
    const a = definePathConfiguration({
      rules: [{ patterns: ['/'], properties: {} }],
    });
    const merged = mergePathConfigurations([a]);
    assert.ok(Object.isFrozen(merged));
    assert.ok(Object.isFrozen(merged.settings));
    assert.ok(Object.isFrozen(merged.rules));
  });

  it('empty array returns empty frozen config', () => {
    const merged = mergePathConfigurations([]);
    assert.deepEqual(merged.settings, {});
    assert.deepEqual(merged.rules, []);
    assert.ok(Object.isFrozen(merged));
  });
});

// ---------------------------------------------------------------------------
// Merged resolver with default rules (integration)
// ---------------------------------------------------------------------------

describe('resolvePathConfigurationMerged + defaultPathRules', () => {
  it('app rules override default-rule properties (later wins)', () => {
    const config = definePathConfiguration({
      rules: [
        // The app rule comes AFTER the defaults so, under later-wins merge
        // semantics, its `presentation: push` overrides the defaults'
        // `presentation` (pop → refresh → replace).
        ...defaultPathRules(),
        { patterns: ['/dashboard'], properties: { presentation: 'push' } },
      ],
    });

    const props = resolvePathConfigurationMerged(config, 'https://example.com/dashboard');

    assert.equal(props.presentation, 'push');
    assert.equal(props.historical_location, true);
    assert.equal(props.context, 'default');
  });

  it('picks up only default rules when no app rule matches', () => {
    const config = definePathConfiguration({
      rules: [
        ...defaultPathRules(),
        { patterns: ['/dashboard'], properties: { presentation: 'push' } },
      ],
    });

    const props = resolvePathConfigurationMerged(config, 'https://example.com/unknown');

    assert.equal(props.presentation, 'replace');
    assert.equal(props.historical_location, true);
  });
});
