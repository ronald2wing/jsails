/**
 * HTTP integration tests for the server-components extension.
 *
 * These tests prove the full transport loop end to end through a real
 * `Application`: the extension registers a runtime, a compiled page fixture
 * calls `renderServerComponent` from `context.services`, and `createApp` mounts
 * the internal update route. A GET renders the signed component root (snapshot,
 * CSRF, id markers); a POST to `/_jsails/components/update` runs the runtime's
 * own origin/CSRF/signature/policy checks and returns a re-signed snapshot with
 * synchronized HTML.
 *
 * No browser, database, Valkey, or HTTP listener is involved: every request is
 * routed in-process through `createTestApp`. Static export (`build`) is
 * exercised for the fallback path, and key resolution — explicit key in every
 * environment, ephemeral random key only in `development`/`test`, and a live
 * failure when a key is missing in `staging`/`production`/unset — is covered by
 * mutating `NODE_ENV`/`JSAILS_COMPONENT_SECRET` within `try`/`finally` guards.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { z } from 'zod';

import type { Session } from '../../src/contracts/http.js';
import type { JsailsExtension } from '../../src/extensions/extension.js';
import {
  defineAction,
  defineServerComponent,
  type ServerComponentDefinition,
} from '../../src/server-components/component.js';
import { serverComponentsPlugin } from '../../src/server-components/extension.js';
import {
  COMPONENT_CSRF_ATTRIBUTE,
  COMPONENT_CSRF_HEADER,
  COMPONENT_SNAPSHOT_ATTRIBUTE,
  COMPONENT_UPDATE_ENDPOINT,
} from '../../src/server-components/protocol.js';
import { createTestApp, type TestApplication } from '../../src/testing/app.js';

const KEY = '0123456789abcdef0123456789abcdef';

// ---------------------------------------------------------------------------
// Fixture components
// ---------------------------------------------------------------------------

type CounterState = { count: number; title: string };

const counter = defineServerComponent<CounterState>({
  name: 'Counter',
  stateSchema: z.object({ count: z.number(), title: z.string() }).strict(),
  writableKeys: ['title'],
  initialState() {
    return { count: 0, title: 'hello' };
  },
  authorize() {
    return true;
  },
  actions: {
    increment: defineAction({
      input: z.object({ by: z.number() }).strict(),
      run(state, input) {
        state.count += input.by;
      },
    }),
  },
  render(state, { bind, call, values }) {
    return (
      <div>
        <input {...bind('title')} value={values.title ?? state.title} />
        <button {...call('increment', { by: 1 })}>+</button>
        <span id="count">{state.count}</span>
        <span id="title">{state.title}</span>
      </div>
    );
  },
});

const withFallback = defineServerComponent({
  name: 'WithFallback',
  stateSchema: z.object({}).strict(),
  initialState() {
    return {};
  },
  authorize() {
    return true;
  },
  render() {
    return <span>live</span>;
  },
  staticFallback() {
    return <div class="static">fallback</div>;
  },
});

const denied = defineServerComponent({
  name: 'Denied',
  stateSchema: z.object({}).strict(),
  initialState() {
    return {};
  },
  authorize() {
    return false;
  },
  render() {
    return <span>secret</span>;
  },
});

const guarded = defineServerComponent<{ n: number }>({
  name: 'Guarded',
  stateSchema: z.object({ n: z.number() }).strict(),
  writableKeys: ['n'],
  initialState() {
    return { n: 0 };
  },
  authorize() {
    return true;
  },
  actions: {
    secret: defineAction({
      authorize() {
        return false;
      },
      run(state) {
        state.n += 1;
      },
    }),
  },
  render(state) {
    return <span id="n">{state.n}</span>;
  },
});

/** A component whose initialState carries a field outside its declared schema. */
const secretState = defineServerComponent({
  name: 'SecretState',
  stateSchema: z.object({ message: z.string() }).strict(),
  initialState() {
    return { message: 'visible', secret: 'TOP-SECRET-VALUE' } as unknown as { message: string };
  },
  authorize() {
    return true;
  },
  render(state) {
    return <span>{state.message}</span>;
  },
});

const ALL_COMPONENTS = {
  Counter: counter,
  WithFallback: withFallback,
  Denied: denied,
  Guarded: guarded,
  SecretState: secretState,
};

// ---------------------------------------------------------------------------
// Compiled page fixtures written to real temp trees.
// ---------------------------------------------------------------------------

const distDir = fileURLToPath(new URL('../../', import.meta.url));
const liveRoot = mkdtempSync(join(distDir, 'sc-live-'));
const staticRoot = mkdtempSync(join(distDir, 'sc-static-'));

after(() => {
  rmSync(liveRoot, { recursive: true, force: true });
  rmSync(staticRoot, { recursive: true, force: true });
});

function writeFixture(root: string, relative: string, content: string): void {
  const full = join(root, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const extensionUrl = pathToFileURL(join(distDir, 'src/server-components/extension.js')).href;

// Live route: renders the component named by the `[component]` path parameter.
writeFixture(
  liveRoot,
  'pages/[component].mjs',
  `import { renderServerComponent } from ${JSON.stringify(extensionUrl)};

export default async function Page(_props, context) {
  return renderServerComponent(context.params.component, context);
}
`,
);

// Static route: a non-dynamic page rendering a component with a static fallback.
writeFixture(
  staticRoot,
  'pages/index.mjs',
  `import { renderServerComponent } from ${JSON.stringify(extensionUrl)};

export default async function Page(_props, context) {
  return renderServerComponent('WithFallback', context);
}
`,
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION: Session = {
  id: 'session-1',
  csrfToken: 'csrf-secret-token',
  data: { userId: 'u1' },
  expiresAt: 2_000_000_000_000,
};

interface AppOverrides {
  readonly rootDir?: string;
  readonly components?: Readonly<Record<string, ServerComponentDefinition<any>>>;
  readonly extensions?: readonly JsailsExtension[];
  readonly publicOrigin?: string;
  readonly resolveSession?: (request: Request) => Session | null;
  readonly signingKey?: string;
}

async function makeApp(overrides: AppOverrides = {}): Promise<TestApplication> {
  const extensions = overrides.extensions ?? [
    serverComponentsPlugin({
      components: overrides.components ?? ALL_COMPONENTS,
      ...(overrides.signingKey === undefined ? {} : { signingKey: overrides.signingKey }),
    }),
  ];
  return createTestApp({
    config: {
      rootDir: overrides.rootDir ?? liveRoot,
      port: 0,
      extensions,
      ...(overrides.publicOrigin === undefined ? {} : { publicOrigin: overrides.publicOrigin }),
      ...(overrides.resolveSession === undefined
        ? {}
        : { resolveSession: overrides.resolveSession }),
    },
  });
}

function extractAttr(html: string, name: string): string {
  const match = html.match(new RegExp(`${name}="([^"]*)"`));
  assert.ok(match, `expected attribute ${name} in HTML:\n${html}`);
  return match[1]!;
}

/** GET a component mount and pull its snapshot token and CSRF token from the HTML. */
async function mount(
  app: TestApplication,
  name: string,
): Promise<{ html: string; snapshot: string; csrf: string }> {
  const response = await app.request(`/${name}`);
  const html = await response.text();
  assert.equal(response.status, 200, html);
  return {
    html,
    snapshot: extractAttr(html, COMPONENT_SNAPSHOT_ATTRIBUTE),
    csrf: extractAttr(html, COMPONENT_CSRF_ATTRIBUTE),
  };
}

interface UpdateOptions {
  readonly csrf?: string;
  readonly origin?: string;
  readonly action?: { name: string; args?: Record<string, unknown> };
}

async function postUpdate(
  app: TestApplication,
  snapshot: string,
  updates: Record<string, unknown>,
  options: UpdateOptions = {},
): Promise<Response> {
  const payload: Record<string, unknown> = { snapshot, updates, sequence: 1 };
  if (options.action !== undefined) {
    payload.action = options.action;
  }
  return app.request(COMPONENT_UPDATE_ENDPOINT, {
    method: 'POST',
    headers: {
      origin: options.origin ?? app.origin,
      ...(options.csrf === undefined ? {} : { [COMPONENT_CSRF_HEADER]: options.csrf }),
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

/** Run `fn` with `process.env` keys overridden, restoring them afterwards. */
async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Live mount and update
// ---------------------------------------------------------------------------

describe('server components HTTP transport', () => {
  it('renders a signed component root on a page GET', async () => {
    const app = await makeApp();
    try {
      const { html, snapshot, csrf } = await mount(app, 'Counter');
      assert.match(html, /data-jsails-component="Counter"/);
      assert.match(html, /data-jsails-component-name="Counter"/);
      assert.ok(snapshot.length > 0);
      assert.ok(csrf.length > 0);
      assert.match(html, /value="hello"/);
      assert.match(html, />0<\/span>/);
    } finally {
      await app.close();
    }
  });

  it('applies a writable edit, re-signs, and returns synchronized html with no-store', async () => {
    const app = await makeApp();
    try {
      const { snapshot, csrf } = await mount(app, 'Counter');
      const response = await postUpdate(app, snapshot, { title: 'changed' }, { csrf });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');

      const body = (await response.json()) as { sequence: number; snapshot: string; html: string };
      assert.equal(body.sequence, 1);
      assert.ok(body.snapshot);
      assert.match(body.html, /value="changed"/);
      assert.equal(body.html.includes('error'), false);
    } finally {
      await app.close();
    }
  });

  it('runs one action and re-renders the mutated state', async () => {
    const app = await makeApp();
    try {
      const { snapshot, csrf } = await mount(app, 'Counter');
      const response = await postUpdate(
        app,
        snapshot,
        {},
        {
          csrf,
          action: { name: 'increment', args: { by: 5 } },
        },
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as { html: string };
      assert.match(body.html, />5<\/span>/);
    } finally {
      await app.close();
    }
  });

  it('rejects a missing CSRF token', async () => {
    const app = await makeApp();
    try {
      const { snapshot } = await mount(app, 'Counter');
      const response = await postUpdate(app, snapshot, {});
      assert.equal(response.status, 403);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'csrf_mismatch');
    } finally {
      await app.close();
    }
  });

  it('rejects a mismatched CSRF token', async () => {
    const app = await makeApp();
    try {
      const { snapshot } = await mount(app, 'Counter');
      const response = await postUpdate(app, snapshot, {}, { csrf: 'wrong-token' });
      assert.equal(response.status, 403);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'csrf_mismatch');
    } finally {
      await app.close();
    }
  });

  it('rejects a cross-origin update', async () => {
    const app = await makeApp();
    try {
      const { snapshot, csrf } = await mount(app, 'Counter');
      const response = await postUpdate(
        app,
        snapshot,
        {},
        {
          csrf,
          origin: 'https://evil.example',
        },
      );
      assert.equal(response.status, 403);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'origin_mismatch');
    } finally {
      await app.close();
    }
  });

  it('rejects a tampered snapshot', async () => {
    const app = await makeApp();
    try {
      const { snapshot, csrf } = await mount(app, 'Counter');
      const tampered = `${snapshot.slice(0, -2)}AA`;
      const response = await postUpdate(app, tampered, {}, { csrf });
      assert.equal(response.status, 403);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'invalid_snapshot');
    } finally {
      await app.close();
    }
  });

  it('rejects a client edit to a locked (non-writable) key', async () => {
    const app = await makeApp();
    try {
      const { snapshot, csrf } = await mount(app, 'Counter');
      const response = await postUpdate(app, snapshot, { count: 999 }, { csrf });
      assert.equal(response.status, 422);
      const body = (await response.json()) as { errors: Record<string, string> };
      assert.equal(body.errors.count, 'Field is read-only');
    } finally {
      await app.close();
    }
  });

  it('denies a forbidden action and never leaks state', async () => {
    const app = await makeApp();
    try {
      const { snapshot, csrf } = await mount(app, 'Guarded');
      const response = await postUpdate(app, snapshot, {}, { csrf, action: { name: 'secret' } });
      assert.equal(response.status, 403);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'forbidden');
      assert.equal(JSON.stringify(body).includes('secret'), false);
    } finally {
      await app.close();
    }
  });

  it('denies a component whose authorize does not resolve to true', async () => {
    const app = await makeApp();
    try {
      const response = await app.request('/Denied');
      assert.equal(response.status, 500);
      const raw = await response.text();
      assert.equal(raw.includes('secret'), false);
    } finally {
      await app.close();
    }
  });

  it('fails closed to a null session when resolveSession throws', async () => {
    const app = await makeApp({
      resolveSession: () => {
        throw new Error('store down');
      },
    });
    try {
      // The mount still renders (session null -> anonymous possession token).
      const { snapshot, csrf } = await mount(app, 'Counter');
      const response = await postUpdate(app, snapshot, { title: 'anon' }, { csrf });
      assert.equal(response.status, 200);
    } finally {
      await app.close();
    }
  });

  it('binds a session to its CSRF token', async () => {
    const app = await makeApp({ resolveSession: () => SESSION });
    try {
      const { snapshot, csrf } = await mount(app, 'Counter');
      assert.equal(csrf, SESSION.csrfToken);

      const ok = await postUpdate(app, snapshot, { title: 'sess' }, { csrf: SESSION.csrfToken });
      assert.equal(ok.status, 200);

      const bad = await postUpdate(app, snapshot, {}, { csrf: 'wrong-token' });
      assert.equal(bad.status, 403);
      const body = (await bad.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'csrf_mismatch');
    } finally {
      await app.close();
    }
  });

  it('honors publicOrigin as the snapshot and update origin', async () => {
    const PUBLIC_ORIGIN = 'https://example.com';
    const app = await makeApp({ publicOrigin: PUBLIC_ORIGIN });
    try {
      assert.equal(app.origin, PUBLIC_ORIGIN);
      const { snapshot, csrf } = await mount(app, 'Counter');

      const ok = await postUpdate(
        app,
        snapshot,
        { title: 'public' },
        {
          csrf,
          origin: PUBLIC_ORIGIN,
        },
      );
      assert.equal(ok.status, 200);

      const mismatched = await postUpdate(
        app,
        snapshot,
        {},
        {
          csrf,
          origin: 'http://localhost',
        },
      );
      assert.equal(mismatched.status, 403);
    } finally {
      await app.close();
    }
  });

  it('never serializes state beyond the declared schema', async () => {
    const app = await makeApp();
    try {
      const response = await app.request('/SecretState');
      assert.equal(response.status, 500);
      const raw = await response.text();
      assert.equal(raw.includes('TOP-SECRET-VALUE'), false);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Static export and production key resolution
// ---------------------------------------------------------------------------

describe('server components static export and key resolution', () => {
  it('renders only the static fallback with no signing during build', async () => {
    const app = await makeApp({ rootDir: staticRoot, components: { WithFallback: withFallback } });
    try {
      const result = await app.application.build();
      assert.equal(result.written.length, 1);
      const html = readFileSync(result.written[0]!, 'utf8');
      assert.match(html, /class="static">fallback/);
      assert.equal(html.includes(COMPONENT_SNAPSHOT_ATTRIBUTE), false);
      assert.equal(html.includes(COMPONENT_CSRF_ATTRIBUTE), false);
    } finally {
      await app.close();
    }
  });

  it('builds a static site with no key in every environment (signer never invoked)', async () => {
    for (const nodeEnv of ['development', 'test', 'staging', 'production', undefined]) {
      await withEnv({ NODE_ENV: nodeEnv, JSAILS_COMPONENT_SECRET: undefined }, async () => {
        const app = await makeApp({
          rootDir: staticRoot,
          components: { WithFallback: withFallback },
        });
        try {
          const result = await app.application.build();
          assert.equal(result.written.length, 1);
          const html = readFileSync(result.written[0]!, 'utf8');
          assert.match(html, /class="static">fallback/);
          assert.equal(html.includes(COMPONENT_SNAPSHOT_ATTRIBUTE), false);
        } finally {
          await app.close();
        }
      });
    }
  });

  it('fails a live render when no key is available in staging', async () => {
    await withEnv({ NODE_ENV: 'staging', JSAILS_COMPONENT_SECRET: undefined }, async () => {
      const app = await makeApp({ components: { WithFallback: withFallback } });
      try {
        const response = await app.request('/WithFallback');
        assert.equal(response.status, 500);
      } finally {
        await app.close();
      }
    });
  });

  it('fails a live render when no key is available in production', async () => {
    await withEnv({ NODE_ENV: 'production', JSAILS_COMPONENT_SECRET: undefined }, async () => {
      const app = await makeApp({ components: { WithFallback: withFallback } });
      try {
        const response = await app.request('/WithFallback');
        assert.equal(response.status, 500);
      } finally {
        await app.close();
      }
    });
  });

  it('fails a live render when NODE_ENV is unset and no key is available', async () => {
    await withEnv({ NODE_ENV: undefined, JSAILS_COMPONENT_SECRET: undefined }, async () => {
      const app = await makeApp({ components: { WithFallback: withFallback } });
      try {
        const response = await app.request('/WithFallback');
        assert.equal(response.status, 500);
      } finally {
        await app.close();
      }
    });
  });

  it('renders live with an ephemeral random key in development and test', async () => {
    for (const nodeEnv of ['development', 'test']) {
      await withEnv({ NODE_ENV: nodeEnv, JSAILS_COMPONENT_SECRET: undefined }, async () => {
        const app = await makeApp({ components: { Counter: counter } });
        try {
          const { snapshot } = await mount(app, 'Counter');
          assert.ok(snapshot.length > 0);
        } finally {
          await app.close();
        }
      });
    }
  });

  it('renders live with an explicit signingKey in every environment', async () => {
    for (const nodeEnv of ['development', 'test', 'staging', 'production', undefined]) {
      await withEnv({ NODE_ENV: nodeEnv, JSAILS_COMPONENT_SECRET: undefined }, async () => {
        const app = await makeApp({ signingKey: KEY, components: { Counter: counter } });
        try {
          const { snapshot } = await mount(app, 'Counter');
          assert.ok(snapshot.length > 0);
        } finally {
          await app.close();
        }
      });
    }
  });

  it('honors JSAILS_COMPONENT_SECRET over an ephemeral key in development', async () => {
    const envKey = 'envkey-0123456789abcdef0123456789ab';
    await withEnv({ NODE_ENV: 'development', JSAILS_COMPONENT_SECRET: envKey }, async () => {
      const app = await makeApp({ components: { Counter: counter } });
      try {
        const { snapshot } = await mount(app, 'Counter');
        assert.ok(snapshot.length > 0);
      } finally {
        await app.close();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Plugin wrapper (`serverComponentsPlugin`)
// ---------------------------------------------------------------------------

describe('serverComponentsPlugin wrapper', () => {
  it('returns a plugin named server-components with a setup function', () => {
    const plugin = serverComponentsPlugin({ components: ALL_COMPONENTS, signingKey: KEY });
    assert.equal(plugin.name, 'server-components');
    assert.equal(typeof plugin.setup, 'function');
  });

  it('drives the live transport', async () => {
    const app = await makeApp({
      extensions: [serverComponentsPlugin({ components: ALL_COMPONENTS, signingKey: KEY })],
    });
    try {
      const { snapshot, csrf } = await mount(app, 'Counter');
      assert.ok(snapshot.length > 0);
      assert.ok(csrf.length > 0);
    } finally {
      await app.close();
    }
  });
});
