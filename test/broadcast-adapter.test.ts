/**
 * Tests for the broadcast adapter seam: attaching a custom {@link BroadcastAdapter}
 * to a real local HTTP server, broadcast/emit delegation, close semantics for
 * both `closesHttpServer` values, adapter/handle validation, and error and
 * idempotence behavior. The custom path must not initialize Socket.IO or start
 * a Redis/Valkey client, so these cases run against bare `node:http` servers on
 * loopback with no external service.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { describe, it } from 'node:test';

import {
  attachBroadcast,
  type BroadcastAdapter,
  type BroadcastHandle,
} from '../src/broadcast/server.js';
import type { JsonValue } from '../src/contracts/http.js';

const ORIGIN = 'https://app.example';

function listen(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

/** A bare handle whose broadcast/close calls are recorded for assertions. */
interface FakeHandle extends BroadcastHandle {
  recorded: Array<{ channel: string; event: string; data: JsonValue }>;
  closeCalls: number;
}

function fakeHandle(closesHttpServer: boolean, opts: { closeDelayMs?: number } = {}): FakeHandle {
  const handle: FakeHandle = {
    recorded: [],
    closeCalls: 0,
    closesHttpServer,
    broadcast(channel, event, data) {
      handle.recorded.push({ channel, event, data });
    },
    close() {
      handle.closeCalls += 1;
      if (opts.closeDelayMs !== undefined) {
        return new Promise<void>((resolve) => setTimeout(resolve, opts.closeDelayMs));
      }
      return Promise.resolve();
    },
  };
  return handle;
}

describe('broadcast custom adapter', () => {
  it('attaches to the existing server and delegates broadcast and emit', async () => {
    const httpServer = createServer();
    let attachedServer: HttpServer | undefined;
    const handle = fakeHandle(false);
    const adapter: BroadcastAdapter = {
      name: 'fake',
      attach(server) {
        attachedServer = server;
        return handle;
      },
    };

    const broadcast = await attachBroadcast(httpServer, { adapter });

    assert.equal(attachedServer, httpServer, 'attach receives the caller-owned server');
    assert.equal(broadcast.closesHttpServer, false);

    broadcast.broadcast('room-1', 'ping', { a: 1 });
    broadcast.emit('room-2', 'pong', [1, 2]);
    assert.deepEqual(handle.recorded, [
      { channel: 'room-1', event: 'ping', data: { a: 1 } },
      { channel: 'room-2', event: 'pong', data: [1, 2] },
    ]);

    await broadcast.close();
  });

  it('does not initialize Socket.IO or Redis for a custom adapter', async () => {
    const httpServer = createServer();
    const handle = fakeHandle(false);

    const broadcast = await attachBroadcast(httpServer, {
      adapter: { name: 'fake', attach: () => handle },
    });

    // Socket.IO/Engine.IO would mount request/upgrade handlers on the server; the
    // custom path must add none (and therefore constructs no Socket.IO server or
    // Redis-backed adapter).
    assert.equal(httpServer.listenerCount('request'), 0);
    assert.equal(httpServer.listenerCount('upgrade'), 0);
    assert.equal(httpServer.listening, false);
    await broadcast.close();
  });

  it('leaves the HTTP server alive when closesHttpServer is false', async () => {
    const httpServer = createServer();
    await listen(httpServer);
    const handle = fakeHandle(false);

    const broadcast = await attachBroadcast(httpServer, {
      adapter: { name: 'fake', attach: () => handle },
    });
    assert.equal(httpServer.listening, true);

    await broadcast.close();
    assert.equal(handle.closeCalls, 1);
    assert.equal(httpServer.listening, true, 'the caller owns the server; it must survive close');

    await closeHttpServer(httpServer);
  });

  it('does not close the HTTP server a second time when the adapter owns teardown', async () => {
    const httpServer = createServer();
    await listen(httpServer);

    const originalClose = httpServer.close.bind(httpServer);
    let closeCalls = 0;
    httpServer.close = (callback?: (error?: Error) => void) => {
      closeCalls += 1;
      return originalClose(callback);
    };

    const adapter: BroadcastAdapter = {
      name: 'owner',
      attach: () => ({
        broadcast: () => {},
        close: () =>
          new Promise<void>((resolve, reject) => {
            httpServer.close((error) => (error === undefined ? resolve() : reject(error)));
          }),
        closesHttpServer: true,
      }),
    };

    const broadcast = await attachBroadcast(httpServer, { adapter });
    await broadcast.close();

    assert.equal(httpServer.listening, false);
    assert.equal(
      closeCalls,
      1,
      'only the adapter closes the server; the core must not re-close it',
    );

    // Idempotent: a second close must not re-close the already-closed server.
    await broadcast.close();
    assert.equal(closeCalls, 1);
  });

  it('supports an adapter whose attach resolves asynchronously', async () => {
    const httpServer = createServer();
    const handle = fakeHandle(true);
    const adapter: BroadcastAdapter = {
      name: 'async',
      attach: async () => handle,
    };

    const broadcast = await attachBroadcast(httpServer, { adapter });
    assert.equal(broadcast.closesHttpServer, true);
    await broadcast.close();
  });

  it('propagates a rejected attach without touching the HTTP server', async () => {
    const httpServer = createServer();
    const adapter: BroadcastAdapter = {
      name: 'failing',
      attach: () => Promise.reject(new Error('attach failed')),
    };

    await assert.rejects(attachBroadcast(httpServer, { adapter }), /attach failed/);
    assert.equal(httpServer.listenerCount('request'), 0);
    assert.equal(httpServer.listenerCount('upgrade'), 0);
    assert.equal(httpServer.listening, false);
  });

  it('validates the adapter shape before attaching', async () => {
    const httpServer = createServer();

    await assert.rejects(
      attachBroadcast(httpServer, { adapter: null as unknown as BroadcastAdapter }),
      TypeError,
    );
    await assert.rejects(
      attachBroadcast(httpServer, {
        adapter: { attach: () => fakeHandle(false) } as unknown as BroadcastAdapter,
      }),
      /name/,
    );
    await assert.rejects(
      attachBroadcast(httpServer, {
        adapter: { name: 'x' } as unknown as BroadcastAdapter,
      }),
      /attach/,
    );
  });

  it('validates the returned handle shape', async () => {
    const httpServer = createServer();

    await assert.rejects(
      attachBroadcast(httpServer, {
        adapter: {
          name: 'x',
          attach: () => ({ close: () => Promise.resolve(), closesHttpServer: false }),
        } as unknown as BroadcastAdapter,
      }),
      /broadcast/,
    );
    await assert.rejects(
      attachBroadcast(httpServer, {
        adapter: {
          name: 'x',
          attach: () => ({ broadcast: () => {}, closesHttpServer: false }),
        } as unknown as BroadcastAdapter,
      }),
      /close/,
    );
    await assert.rejects(
      attachBroadcast(httpServer, {
        adapter: {
          name: 'x',
          attach: () => ({ broadcast: () => {}, close: () => Promise.resolve() }),
        } as unknown as BroadcastAdapter,
      }),
      /closesHttpServer/,
    );
  });

  it('closes once and resolves concurrently for all callers', async () => {
    const httpServer = createServer();
    const handle = fakeHandle(false, { closeDelayMs: 20 });

    const broadcast = await attachBroadcast(httpServer, {
      adapter: { name: 'fake', attach: () => handle },
    });

    await Promise.all([broadcast.close(), broadcast.close(), broadcast.close()]);
    assert.equal(handle.closeCalls, 1, 'the wrapper must invoke the handle close exactly once');
  });

  it('disposes a malformed handle best-effort and surfaces the validation error', async () => {
    const httpServer = createServer();
    let coreCloseCalls = 0;
    const originalClose = httpServer.close.bind(httpServer);
    httpServer.close = (callback?: (error?: Error) => void) => {
      coreCloseCalls += 1;
      return originalClose(callback);
    };

    let handleCloseCalls = 0;
    const malformed = {
      // Missing broadcast/closesHttpServer: validation must fail after attach.
      marker: true,
      close(this: { marker?: boolean }) {
        assert.equal(this.marker, true, 'close is invoked with the handle as its receiver');
        handleCloseCalls += 1;
        return Promise.resolve();
      },
    };
    const adapter: BroadcastAdapter = {
      name: 'malformed',
      attach: () => malformed as unknown as BroadcastHandle,
    };

    await assert.rejects(attachBroadcast(httpServer, { adapter }), /broadcast/);
    assert.equal(handleCloseCalls, 1, 'the malformed handle close is invoked exactly once');
    assert.equal(coreCloseCalls, 0, 'the core never closes the caller-owned HTTP server');
  });

  it('tolerates a malformed handle with no close function', async () => {
    const httpServer = createServer();
    const adapter: BroadcastAdapter = {
      name: 'malformed',
      attach: () =>
        ({ broadcast: () => {}, closesHttpServer: false }) as unknown as BroadcastHandle,
    };

    await assert.rejects(attachBroadcast(httpServer, { adapter }), /close/);
  });

  it('aggregates a cleanup failure behind the original validation error', async () => {
    const httpServer = createServer();
    const cleanupError = new Error('cleanup exploded');
    const adapter: BroadcastAdapter = {
      name: 'malformed',
      attach: () =>
        ({
          close: () => Promise.reject(cleanupError),
        }) as unknown as BroadcastHandle,
    };

    await assert.rejects(attachBroadcast(httpServer, { adapter }), (error: unknown) => {
      assert.ok(error instanceof AggregateError, 'both failures are surfaced, not masked');
      const [validationError, cleanup] = error.errors;
      assert.ok(validationError instanceof TypeError);
      assert.match(String(validationError), /broadcast/);
      assert.equal(cleanup, cleanupError);
      assert.equal(error.cause, validationError, 'the original validation error remains the cause');
      return true;
    });
  });
});

describe('built-in Socket.IO adapter factory', () => {
  it('exposes a real, option-validating factory with a named attach', () => {
    // Imported directly to assert the factory is a genuine implementation (not
    // an unused interface) that validates options and never opens a connection.
    return import('../src/broadcast/socketio-adapter.js').then(
      ({ createSocketIOBroadcastAdapter }) => {
        assert.equal(typeof createSocketIOBroadcastAdapter, 'function');

        const adapter = createSocketIOBroadcastAdapter({
          allowedOrigins: [ORIGIN],
          authenticate: () => ({ id: 'user-1' }),
          authorizeChannel: () => true,
        });
        assert.equal(adapter.name, 'socket.io');
        assert.equal(typeof adapter.attach, 'function');

        assert.throws(
          () => createSocketIOBroadcastAdapter({ allowedOrigins: [], authenticate: () => null }),
          TypeError,
        );
      },
    );
  });
});
