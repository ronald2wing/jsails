/**
 * Tests for the first-party `broadcast` plugin and the `onServe` lifecycle it
 * builds on, exercised through a real `Application` (createApplication +
 * serve) over loopback. Each case binds an ephemeral port on 127.0.0.1, so no
 * privileged port or external service is required; the built-in Socket.IO cases
 * run without Redis. Timeouts bound every socket wait so a failure surfaces as
 * an error rather than a hang.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server as NodeHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { io as createClient } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';

import { createApplication } from '../../src/app/application.js';
import { validateAppConfig } from '../../src/app/config/index.js';
import { broadcastPlugin } from '../../src/broadcast/plugin.js';
import { BROADCAST_PATH, type BroadcastAdapter } from '../../src/broadcast/server.js';
import { createServiceToken } from '../../src/extensions/services.js';
import type { JsailsExtension } from '../../src/extensions/index.js';

const ORIGIN = 'https://app.example';
const WAIT_MS = 3000;
// Mirrored from src/broadcast/socketio-adapter.ts (not exported).
const SUBSCRIBE_EVENT = 'jsails:subscribe';

const root = mkdtempSync(join(tmpdir(), 'jsails-broadcast-plugin-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Default identity: the token after `Bearer ` in the Authorization header. */
function bearerIdentity(handshake: { headers: { authorization?: string } }): string | null {
  const auth = handshake.headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ')
    ? auth.slice('Bearer '.length)
    : null;
}

function makeConfig(dir: string, overrides: Record<string, unknown> = {}) {
  return validateAppConfig({ rootDir: dir, port: 0, ...overrides }, { cwd: dir });
}

/** Connect a Socket.IO client to the broadcast path on `port`. */
function connectSocket(port: number): Promise<ClientSocket> {
  const socket = createClient(`http://127.0.0.1:${port}`, {
    path: BROADCAST_PATH,
    transports: ['websocket'],
    reconnection: false,
    timeout: 2000,
    extraHeaders: { Origin: ORIGIN, Authorization: 'Bearer test-user' },
  });
  return new Promise<ClientSocket>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('connect timed out'));
    }, WAIT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function subscribeRaw(
  socket: ClientSocket,
  channels: string[],
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('subscribe ack timed out')), WAIT_MS);
    socket.emit(SUBSCRIBE_EVENT, { channels }, (response: { ok: boolean; error?: string }) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

// ---------------------------------------------------------------------------
// onServe lifecycle through the application
// ---------------------------------------------------------------------------

describe('onServe lifecycle', () => {
  it('hands each serve hook the bound server and the service registry, before listen, in declaration order', async () => {
    const dir = mkdtempSync(join(root, 'onserve-order-'));
    const token = createServiceToken<string>('svc');
    const order: string[] = [];
    const servers: NodeHttpServer[] = [];
    const listeningAtHook: boolean[] = [];
    const values: string[] = [];

    const provider: JsailsExtension = {
      name: 'provider',
      setup({ services, onServe }) {
        services.provide(token, 'from-service');
        onServe((server, context) => {
          order.push('provider');
          servers.push(server);
          listeningAtHook.push(server.listening);
          values.push(context.services.get(token));
        });
      },
    };
    const consumer: JsailsExtension = {
      name: 'consumer',
      setup({ onServe }) {
        onServe((server, context) => {
          order.push('consumer');
          servers.push(server);
          listeningAtHook.push(server.listening);
          values.push(context.services.get(token));
        });
      },
    };

    const app = await createApplication(makeConfig(dir, { extensions: [provider, consumer] }));
    const handle = await app.serve();
    try {
      assert.deepEqual(order, ['provider', 'consumer'], 'hooks run in declaration order');
      assert.deepEqual(values, ['from-service', 'from-service'], 'hooks read the sealed registry');
      assert.deepEqual(listeningAtHook, [false, false], 'hooks run before the server listens');
      assert.ok(
        servers.every((server) => server === handle.server),
        'hooks see the app-owned server',
      );
      assert.equal(handle.server.listening, true);
    } finally {
      await handle.close();
    }
  });

  it('a throwing serve hook aborts serve, closes the created server, and leaves the app usable', async () => {
    const dir = mkdtempSync(join(root, 'onserve-throw-'));
    const order: string[] = [];
    let captured: NodeHttpServer | undefined;

    const extensions: JsailsExtension[] = [
      {
        name: 'first',
        setup({ onServe }) {
          onServe((server) => {
            order.push('first');
            captured = server;
          });
        },
      },
      {
        name: 'second',
        setup({ onServe }) {
          onServe(() => {
            order.push('second');
            throw new Error('serve boom');
          });
        },
      },
      {
        name: 'third',
        setup({ onServe }) {
          onServe(() => {
            order.push('third');
          });
        },
      },
    ];

    const app = await createApplication(makeConfig(dir, { extensions }));
    await assert.rejects(app.serve(), /serve boom/);

    assert.deepEqual(order, ['first', 'second'], 'hooks run in order and stop at the throw');
    assert.ok(captured, 'the first hook captured the created server');
    assert.equal(captured.listening, false, 'the created server was closed after the throw');

    // The failed serve did not close the app: the shared pipeline still routes.
    const res = await app.fetch(new Request('http://localhost/up'));
    assert.equal(res.status, 200);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// broadcastPlugin
// ---------------------------------------------------------------------------

describe('broadcastPlugin', () => {
  it('attaches to the app server and serves a Socket.IO client on the same port', async () => {
    const dir = mkdtempSync(join(root, 'plugin-socketio-'));
    const plugin = broadcastPlugin({
      allowedOrigins: [ORIGIN],
      authenticate: (handshake) => bearerIdentity(handshake),
      authorizeChannel: () => true,
    });

    const app = await createApplication(makeConfig(dir, { extensions: [plugin] }));
    const handle = await app.serve();
    try {
      const socket = await connectSocket(handle.port);
      assert.deepEqual(await subscribeRaw(socket, ['room-1']), { ok: true });
      socket.close();

      // The same server and port still serve the HTTP application: the plugin
      // never opens a second listener.
      const res = await fetch(new URL('/up', handle.url));
      assert.equal(res.status, 200);
    } finally {
      await handle.close();
    }
  });

  it('closes the transport and the server idempotently with the built-in adapter', async () => {
    const dir = mkdtempSync(join(root, 'plugin-close-'));
    const plugin = broadcastPlugin({
      allowedOrigins: [ORIGIN],
      authenticate: (handshake) => bearerIdentity(handshake),
    });

    const app = await createApplication(makeConfig(dir, { extensions: [plugin] }));
    const handle = await app.serve();
    assert.equal(handle.server.listening, true);

    await app.close();
    assert.equal(handle.server.listening, false, 'the app closes the HTTP server');

    await app.close(); // idempotent
  });

  it('preserves a custom adapter closesHttpServer: false and closes the transport once', async () => {
    const dir = mkdtempSync(join(root, 'plugin-adapter-'));
    const state = {
      attachCalls: 0,
      closeCalls: 0,
      attachedServer: undefined as NodeHttpServer | undefined,
    };
    const adapter: BroadcastAdapter = {
      name: 'fake',
      attach(server) {
        state.attachCalls += 1;
        state.attachedServer = server;
        return {
          closesHttpServer: false,
          broadcast() {},
          close() {
            state.closeCalls += 1;
            return Promise.resolve();
          },
        };
      },
    };

    const app = await createApplication(
      makeConfig(dir, { extensions: [broadcastPlugin({ adapter })] }),
    );
    const handle = await app.serve();
    try {
      assert.equal(state.attachCalls, 1, 'the adapter attach runs exactly once');
      assert.equal(state.attachedServer, handle.server, 'attach receives the app-owned server');

      // Same port still serves HTTP; no second listener was opened.
      const res = await fetch(new URL('/up', handle.url));
      assert.equal(res.status, 200);
    } finally {
      await handle.close();
    }

    assert.equal(state.closeCalls, 1, 'the plugin closes the transport exactly once');
    assert.equal(handle.server.listening, false, 'the app closes the HTTP server itself');

    await app.close(); // idempotent: the transport is not closed again
    assert.equal(state.closeCalls, 1);
  });

  it('rejects a non-object options value', () => {
    assert.throws(() => broadcastPlugin(null as never), TypeError);
    assert.throws(() => broadcastPlugin(42 as never), TypeError);
  });
});
