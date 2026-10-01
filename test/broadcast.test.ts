/**
 * End-to-end tests for the broadcast module against a real local HTTP server
 * and Socket.IO over the loopback interface (no Redis). Each case binds an
 * ephemeral port on 127.0.0.1, so no privileged port or external service is
 * required. Timeouts bound every socket wait so a failure surfaces as an error
 * rather than a hang.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeEach, describe, it } from 'node:test';
import { io as createClient } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import type { Adapter } from 'socket.io-adapter';

import {
  attachBroadcast,
  BROADCAST_PATH,
  type Broadcast,
  type BroadcastOptions,
} from '../src/broadcast/server.js';
import {
  createBroadcastClient,
  type BroadcastClient,
  type BroadcastEvent,
} from '../src/broadcast/client.js';
import {
  closeRedisBroadcastAdapter,
  createRedisBroadcastAdapter,
  type RedisBroadcastAdapterDependencies,
} from '../src/broadcast/redis.js';

// Protocol event names, mirrored from src/broadcast/server.ts (not exported).
const SUBSCRIBE_EVENT = 'jsails:subscribe';
const UNSUBSCRIBE_EVENT = 'jsails:unsubscribe';
const BROADCAST_EVENT = 'jsails:event';

const ORIGIN = 'https://app.example';
const WAIT_MS = 3000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Default identity: the token after `Bearer ` in the Authorization header. */
function bearerIdentity(handshake: { headers: { authorization?: string } }): string | null {
  const auth = handshake.headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ')
    ? auth.slice('Bearer '.length)
    : null;
}

interface RunningBroadcast {
  broadcast: Broadcast;
  httpServer: HttpServer;
  port: number;
}

async function startBroadcast(
  overrides: Partial<BroadcastOptions> = {},
): Promise<RunningBroadcast> {
  const httpServer = createServer();
  const options: BroadcastOptions = {
    allowedOrigins: [ORIGIN],
    authenticate: (handshake) => bearerIdentity(handshake),
    ...overrides,
  };
  const broadcast = await attachBroadcast(httpServer, options);
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  return { broadcast, httpServer, port: (httpServer.address() as AddressInfo).port };
}

/** Connect a raw Socket.IO client for low-level protocol assertions. */
function connectRaw(port: number, origin: string, authorization?: string): Promise<ClientSocket> {
  const socket = createClient(`http://127.0.0.1:${port}`, {
    path: BROADCAST_PATH,
    transports: ['websocket'],
    reconnection: false,
    timeout: 2000,
    extraHeaders: {
      Origin: origin,
      ...(authorization !== undefined ? { Authorization: authorization } : {}),
    },
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

function unsubscribeRaw(
  socket: ClientSocket,
  channels: string[],
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('unsubscribe ack timed out')), WAIT_MS);
    socket.emit(UNSUBSCRIBE_EVENT, { channels }, (response: { ok: boolean; error?: string }) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function nextRawEvent(socket: ClientSocket): Promise<BroadcastEvent> {
  return new Promise((resolve, reject) => {
    const handler = (payload: BroadcastEvent): void => {
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      socket.off(BROADCAST_EVENT, handler);
      reject(new Error('broadcast event timed out'));
    }, WAIT_MS);
    socket.on(BROADCAST_EVENT, handler);
  });
}

async function assertNoRawEvent(socket: ClientSocket, windowMs = 300): Promise<void> {
  let received = false;
  const handler = (): void => {
    received = true;
  };
  socket.on(BROADCAST_EVENT, handler);
  await delay(windowMs);
  socket.off(BROADCAST_EVENT, handler);
  assert.equal(received, false, 'expected no broadcast event');
}

function connectClient(
  port: number,
  authorization: string,
  onError?: (error: Error) => void,
): BroadcastClient {
  return createBroadcastClient({
    url: `http://127.0.0.1:${port}`,
    path: BROADCAST_PATH,
    extraHeaders: { Origin: ORIGIN, Authorization: authorization },
    onError,
  });
}

function nextClientEvent(client: BroadcastClient): Promise<BroadcastEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('broadcast event timed out'));
    }, WAIT_MS);
    const unsubscribe = client.onEvent((event) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

describe('broadcast authentication and origin', () => {
  it('rejects a connection the authenticate callback denies', async () => {
    const { broadcast, port } = await startBroadcast({ authenticate: () => null });
    try {
      await assert.rejects(
        connectRaw(port, ORIGIN, 'Bearer user-1'),
        (error: Error) => error.message === 'unauthorized',
      );
    } finally {
      await broadcast.close();
    }
  });

  it('rejects a connection whose origin is not allowlisted', async () => {
    const { broadcast, port } = await startBroadcast();
    try {
      await assert.rejects(connectRaw(port, 'https://evil.example', 'Bearer user-1'));
    } finally {
      await broadcast.close();
    }
  });

  it('rejects a connection with no origin header', async () => {
    const { broadcast, port } = await startBroadcast();
    const socket = createClient(`http://127.0.0.1:${port}`, {
      path: BROADCAST_PATH,
      transports: ['websocket'],
      reconnection: false,
      timeout: 2000,
    });
    try {
      await assert.rejects(
        new Promise<ClientSocket>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('connect timed out')), WAIT_MS);
          socket.once('connect', () => {
            clearTimeout(timer);
            resolve(socket);
          });
          socket.once('connect_error', (error: Error) => {
            clearTimeout(timer);
            reject(error);
          });
        }),
      );
    } finally {
      socket.close();
      await broadcast.close();
    }
  });
});

describe('broadcast subscription', () => {
  it('denies every channel by default when authorizeChannel is omitted', async () => {
    const { broadcast, port } = await startBroadcast();
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      const response = await subscribeRaw(socket, ['room-1']);
      assert.deepEqual(response, { ok: false, error: 'unauthorized' });
    } finally {
      socket.close();
      await broadcast.close();
    }
  });

  it('delivers a broadcast to an authorized, subscribed client', async () => {
    const { broadcast, port } = await startBroadcast({
      authorizeChannel: (_identity, channel) => channel === 'room-1',
    });
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      const response = await subscribeRaw(socket, ['room-1']);
      assert.deepEqual(response, { ok: true });
      const pending = nextRawEvent(socket);
      broadcast.emit('room-1', 'greeting', { hello: 'world' });
      const event = await pending;
      assert.equal(event.channel, 'room-1');
      assert.equal(event.event, 'greeting');
      assert.deepEqual(event.data, { hello: 'world' });
    } finally {
      socket.close();
      await broadcast.close();
    }
  });

  it('does not deliver to a channel the identity is not authorized for', async () => {
    const { broadcast, port } = await startBroadcast({
      authorizeChannel: (_identity, channel) => channel === 'room-1',
    });
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      assert.deepEqual(await subscribeRaw(socket, ['room-1']), { ok: true });
      assert.deepEqual(await subscribeRaw(socket, ['room-2']), {
        ok: false,
        error: 'unauthorized',
      });

      broadcast.emit('room-2', 'secret', { value: 1 });
      await assertNoRawEvent(socket);

      const pending = nextRawEvent(socket);
      broadcast.emit('room-1', 'still-works', {});
      await pending;
    } finally {
      socket.close();
      await broadcast.close();
    }
  });

  it('stops delivery after an explicit unsubscribe', async () => {
    const { broadcast, port } = await startBroadcast({
      authorizeChannel: (_identity, channel) => channel === 'room-1',
    });
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      assert.deepEqual(await subscribeRaw(socket, ['room-1']), { ok: true });
      const first = nextRawEvent(socket);
      broadcast.emit('room-1', 'first', {});
      await first;

      assert.deepEqual(await unsubscribeRaw(socket, ['room-1']), { ok: true });
      broadcast.emit('room-1', 'second', {});
      await assertNoRawEvent(socket);
    } finally {
      socket.close();
      await broadcast.close();
    }
  });

  it('enforces maxSubscriptions under concurrent delayed authorization', async () => {
    const { broadcast, port } = await startBroadcast({
      maxSubscriptions: 1,
      authorizeChannel: async () => {
        await delay(50);
        return true;
      },
    });
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      // Two subscribes in flight before either authorization resolves: without
      // serialization both pass the cap check and both join.
      const first = subscribeRaw(socket, ['channel-a']);
      const second = subscribeRaw(socket, ['channel-b']);
      const [a, b] = await Promise.all([first, second]);
      assert.equal(
        [a, b].filter((response) => response.ok).length,
        1,
        'only one channel may join under maxSubscriptions=1',
      );

      const pending = nextRawEvent(socket);
      broadcast.emit('channel-a', 'ping', {});
      await pending;

      broadcast.emit('channel-b', 'pong', {});
      await assertNoRawEvent(socket);
    } finally {
      socket.close();
      await broadcast.close();
    }
  });

  it('serializes an unsubscribe behind an in-flight subscribe', async () => {
    const { broadcast, port } = await startBroadcast({
      authorizeChannel: async () => {
        await delay(50);
        return true;
      },
    });
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      const subscribe = subscribeRaw(socket, ['room-x']);
      // Issued before the delayed authorization completes: without
      // serialization the unsubscribe would run first and be lost, leaving the
      // socket subscribed against the caller's intent.
      const unsubscribe = unsubscribeRaw(socket, ['room-x']);
      const [sub, unsub] = await Promise.all([subscribe, unsubscribe]);
      assert.equal(sub.ok, true);
      assert.equal(unsub.ok, true);

      broadcast.emit('room-x', 'ping', {});
      await assertNoRawEvent(socket);
    } finally {
      socket.close();
      await broadcast.close();
    }
  });

  it('rejects malformed subscribe payloads with a generic error', async () => {
    const { broadcast, port } = await startBroadcast({
      authorizeChannel: () => true,
    });
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      for (const payload of [
        null,
        42,
        {},
        { channels: [] },
        { channels: 'room-1' },
        { channels: [42] },
      ]) {
        const response = await new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('ack timed out')), WAIT_MS);
          socket.emit(SUBSCRIBE_EVENT, payload, (r: { ok: boolean; error?: string }) => {
            clearTimeout(timer);
            resolve(r);
          });
        });
        assert.equal(response.ok, false);
        assert.equal(response.error, 'invalid-request');
      }
    } finally {
      socket.close();
      await broadcast.close();
    }
  });
});

describe('broadcast client reconnection', () => {
  it('re-subscribes on reconnect and drops channels whose authorization was revoked', async () => {
    let allowed = true;
    const { broadcast, port } = await startBroadcast({
      authorizeChannel: (_identity, channel) => channel === 'room-1' && allowed,
    });

    let signalError: (() => void) | undefined;
    const errorObserved = new Promise<void>((resolve) => {
      signalError = resolve;
    });

    const client = connectClient(port, 'Bearer user-1', () => signalError?.());
    const received: BroadcastEvent[] = [];
    client.onEvent((event) => received.push(event));

    try {
      await client.subscribe(['room-1']);
      const first = nextClientEvent(client);
      broadcast.emit('room-1', 'before', {});
      const before = await first;
      assert.equal(before.event, 'before');

      // Revoke authorization and force a clean reconnect.
      allowed = false;
      client.disconnect();
      client.connect();

      // The automatic re-join must be denied, surfacing through onError.
      await withTimeout(errorObserved, WAIT_MS, 're-join denial');

      broadcast.emit('room-1', 'after', {});
      await delay(300);
      assert.equal(received.length, 1, 'no event should be delivered after revocation');
      assert.equal(received[0]?.event, 'before');
    } finally {
      client.disconnect();
      await broadcast.close();
    }
  });
});

describe('broadcast validation and lifecycle', () => {
  it('validates channel, event, and payload bounds', async () => {
    const { broadcast } = await startBroadcast({ authorizeChannel: () => true });
    try {
      assert.throws(() => broadcast.emit('', 'e', {}), TypeError);
      assert.throws(() => broadcast.emit('c', '', {}), TypeError);
      assert.throws(() => broadcast.emit('c', 'e', (() => {}) as unknown as never), TypeError);
      assert.throws(() => broadcast.emit('c', 'e', 1n as unknown as never), TypeError);
      assert.throws(() => broadcast.emit('c', 'e', NaN), TypeError);
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      assert.throws(() => broadcast.emit('c', 'e', circular as unknown as never), TypeError);
      assert.throws(() => broadcast.emit('c', 'e', { data: 'x'.repeat(2_000_000) }), RangeError);
    } finally {
      await broadcast.close();
    }
  });

  it('close() shuts down the attached HTTP server (verified Socket.IO behavior)', async () => {
    const { broadcast, httpServer } = await startBroadcast({ authorizeChannel: () => true });
    assert.equal(httpServer.listening, true);
    await broadcast.close();
    assert.equal(httpServer.listening, false);
    // Idempotent.
    await broadcast.close();
  });

  it('close() resolves concurrently for all callers', async () => {
    const { broadcast, httpServer } = await startBroadcast({ authorizeChannel: () => true });
    assert.equal(httpServer.listening, true);
    // Every caller must await the same shutdown rather than resolve early.
    await Promise.all([broadcast.close(), broadcast.close(), broadcast.close()]);
    assert.equal(httpServer.listening, false);
  });
});

describe('broadcast redis adapter', () => {
  it('fails safely before returning when Redis is unreachable', async () => {
    // No real Redis is used: port 1 is privileged and never answers, so the
    // connection is refused and the adapter must reject (and clean up) rather
    // than return a half-initialized server.
    await assert.rejects(
      withTimeout(
        createRedisBroadcastAdapter('redis://127.0.0.1:1'),
        WAIT_MS,
        'redis adapter init',
      ),
      /failed to connect to the Redis broadcast adapter/,
    );
  });

  it('leaves the HTTP server untouched when Redis adapter init fails', async () => {
    const httpServer = createServer();
    await assert.rejects(
      attachBroadcast(httpServer, {
        allowedOrigins: [ORIGIN],
        authenticate: (handshake) => bearerIdentity(handshake),
        redisUrl: 'redis://127.0.0.1:1',
      }),
      /failed to connect to the Redis broadcast adapter/,
    );
    // The adapter initializes before anything is attached, so the HTTP server
    // must still be usable (and not closed) after the failure.
    assert.equal(httpServer.listening, false);
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => {
        const address = httpServer.address() as AddressInfo;
        assert.ok(address.port > 0);
        httpServer.close(() => resolve());
      });
    });
  });
});

// --- Mocked Redis adapter lifecycle (no live Redis) ------------------------

interface FakeRedisBehavior {
  constructError?: Error;
  duplicateError?: Error;
  connectError?: Error;
}

let behavior: FakeRedisBehavior = {};
const createdClients: FakeRedisClient[] = [];

class FakeRedisClient {
  disconnected = false;
  private readonly errorListeners: Array<(error: unknown) => void> = [];

  constructor(_url: string, _options: object) {
    if (behavior.constructError !== undefined) {
      throw behavior.constructError;
    }
    createdClients.push(this);
  }

  duplicate(): FakeRedisClient {
    if (behavior.duplicateError !== undefined) {
      throw behavior.duplicateError;
    }
    return new FakeRedisClient('', {});
  }

  connect(): Promise<void> {
    if (behavior.connectError !== undefined) {
      return Promise.reject(behavior.connectError);
    }
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.disconnected = true;
    return Promise.resolve();
  }

  on(event: 'error', listener: (error: unknown) => void): void {
    if (event === 'error') {
      this.errorListeners.push(listener);
    }
  }

  emitError(error: unknown): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }
}

function fakeDependencies(): RedisBroadcastAdapterDependencies {
  return {
    RedisClient: FakeRedisClient,
    createAdapter: (_pub: unknown, _sub: unknown) => (_nsp: unknown) => ({}) as Adapter,
  };
}

function credentialError(message: string, code: string): Error {
  const error = new Error(message);
  (error as NodeJS.ErrnoException).code = code;
  return error;
}

describe('broadcast redis adapter lifecycle (mocked)', () => {
  beforeEach(() => {
    behavior = {};
    createdClients.length = 0;
  });

  it('sanitizes and rethrows a constructor failure without leaking the URL', async () => {
    behavior.constructError = credentialError(
      'ERR invalid url redis://:supersecret@host:6379',
      'ERR_INVALID_URL',
    );
    await assert.rejects(
      createRedisBroadcastAdapter('redis://:supersecret@host:6379', {}, fakeDependencies()),
      (error: Error) => {
        assert.match(error.message, /failed to connect to the Redis broadcast adapter/);
        assert.doesNotMatch(String(error.cause), /supersecret/);
        return true;
      },
    );
  });

  it('closes the partially created publisher when duplicate fails', async () => {
    behavior.duplicateError = new Error('duplicate failed');
    await assert.rejects(
      createRedisBroadcastAdapter('redis://localhost:6379', {}, fakeDependencies()),
      /failed to connect to the Redis broadcast adapter/,
    );
    assert.equal(createdClients.length, 1);
    assert.equal(createdClients[0]?.disconnected, true);
  });

  it('closes both clients and sanitizes when connect fails', async () => {
    behavior.connectError = credentialError(
      'connect ECONNREFUSED redis://:topsecret@host:6379',
      'ECONNREFUSED',
    );
    await assert.rejects(
      createRedisBroadcastAdapter('redis://:topsecret@host:6379', {}, fakeDependencies()),
      (error: Error) => {
        assert.match(error.message, /failed to connect to the Redis broadcast adapter/);
        assert.doesNotMatch(String(error.cause), /topsecret/);
        return true;
      },
    );
    assert.equal(createdClients.length, 2);
    assert.ok(createdClients.every((client) => client.disconnected));
  });

  it('routes post-connect errors to onError without leaking the URL', async () => {
    const observed: Error[] = [];
    const adapter = await createRedisBroadcastAdapter(
      'redis://:topsecret@host:6379',
      { onError: (error) => observed.push(error) },
      fakeDependencies(),
    );
    const secret = credentialError(
      'ECONNRESET while connected to redis://:topsecret@host:6379',
      'ECONNRESET',
    );
    createdClients[0]?.emitError(secret);
    assert.equal(observed.length, 1);
    assert.match(observed[0]!.message, /Redis broadcast adapter error/);
    assert.doesNotMatch(observed[0]!.message, /topsecret/);
    assert.equal((observed[0] as { cause?: unknown }).cause, undefined);
    await closeRedisBroadcastAdapter(adapter);
  });

  it('swallows a throwing onError observer without crashing', async () => {
    const adapter = await createRedisBroadcastAdapter(
      'redis://localhost:6379',
      {
        onError: () => {
          throw new Error('observer boom');
        },
      },
      fakeDependencies(),
    );
    assert.doesNotThrow(() => createdClients[0]?.emitError(new Error('redis down')));
    await closeRedisBroadcastAdapter(adapter);
  });

  it('falls back to process.emitWarning when no onError is provided', async () => {
    const warnings: Error[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning);
    };
    process.on('warning', onWarning);
    try {
      const adapter = await createRedisBroadcastAdapter(
        'redis://localhost:6379',
        {},
        fakeDependencies(),
      );
      createdClients[0]?.emitError(new Error('redis down'));
      // process.emitWarning delivers the 'warning' event on a later tick.
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!.message, /Redis broadcast adapter error/);
      await closeRedisBroadcastAdapter(adapter);
    } finally {
      process.off('warning', onWarning);
    }
  });
});
