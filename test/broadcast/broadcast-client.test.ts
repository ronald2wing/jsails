/**
 * Tests for the JSails broadcast client: reconnection/backoff config, lifecycle
 * hooks, transient-vs-permanent rejoin failures, and connected-state accessor.
 *
 * Every test drives a {@link SocketIOBroadcastClient} through an injected
 * `ioFactory` that returns a minimal fake Socket — no real HTTP server or
 * Socket.IO transport is used.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SocketIOBroadcastClient, type BroadcastClient } from '../../src/broadcast/client.js';
import type { Socket as RealSocket } from 'socket.io-client';

// ---------------------------------------------------------------------------
// Fake Socket
// ---------------------------------------------------------------------------

type EventHandlerFn = (...args: unknown[]) => void;
type AckCb = (response: unknown) => void;

interface FakeSocket {
  connected: boolean;
  on(event: string, handler: EventHandlerFn): this;
  emit(event: string, ...args: unknown[]): this;
  connect(): this;
  disconnect(): this;
  /** Fire a 'connect' event for all registered listeners. */
  _triggerConnect(): void;
  /** Fire a 'disconnect' event with an optional reason. */
  _triggerDisconnect(reason?: string): void;
  /** Fire a 'connect_error' event. */
  _triggerConnectError(error: Error): void;
  /**
   * If set, the fake will invoke this instead of the normal ack callback for
   * any `jsails:subscribe` emit, passing it the channels array. Cleared after
   * each invocation.
   */
  _captureSubscribeAck: ((channels: string[], ack: AckCb) => void) | null;
}

function createFakeSocket(): FakeSocket {
  const listeners = new Map<string, EventHandlerFn[]>();

  function fire(event: string, ...args: unknown[]): void {
    for (const h of listeners.get(event) ?? []) {
      h(...args);
    }
  }

  const socket: FakeSocket = {
    connected: false,
    _captureSubscribeAck: null,

    on(event: string, handler: EventHandlerFn): FakeSocket {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return socket;
    },

    emit(event: string, ...args: unknown[]): FakeSocket {
      if (event === 'jsails:subscribe' && socket._captureSubscribeAck !== null) {
        const handler = socket._captureSubscribeAck;
        socket._captureSubscribeAck = null;
        // Extract ack from last arg, then invoke capture handler
        const maybeAck = args[args.length - 1];
        const ack = typeof maybeAck === 'function' ? (args.pop() as AckCb) : () => {};
        const payload = (args[0] as { channels?: string[] }) ?? { channels: [] };
        handler(payload.channels ?? [], ack);
        return socket;
      }
      fire(event, ...args);
      return socket;
    },

    connect(): FakeSocket {
      socket.connected = true;
      fire('connect');
      return socket;
    },

    disconnect(): FakeSocket {
      socket.connected = false;
      fire('disconnect', 'io client disconnect');
      return socket;
    },

    _triggerConnect(): void {
      socket.connected = true;
      fire('connect');
    },

    _triggerDisconnect(reason = 'transport close'): void {
      socket.connected = false;
      fire('disconnect', reason);
    },

    _triggerConnectError(error: Error): void {
      fire('connect_error', error);
    },
  };

  return socket;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FixtureOpts {
  autoConnect?: boolean;
  onConnect?: () => void;
  onReconnect?: () => void;
  onDisconnect?: (reason?: string) => void;
  onError?: (error: Error) => void;
  reconnection?: boolean;
  reconnectionAttempts?: number;
  reconnectionDelay?: number;
  reconnectionDelayMax?: number;
}

function makeClient(socket: FakeSocket, opts: FixtureOpts = {}): BroadcastClient {
  return new SocketIOBroadcastClient({
    url: 'http://127.0.0.1:0',
    ioFactory: () => socket as unknown as RealSocket,
    autoConnect: opts.autoConnect ?? false,
    onConnect: opts.onConnect,
    onReconnect: opts.onReconnect,
    onDisconnect: opts.onDisconnect,
    onError: opts.onError,
    reconnection: opts.reconnection,
    reconnectionAttempts: opts.reconnectionAttempts,
    reconnectionDelay: opts.reconnectionDelay,
    reconnectionDelayMax: opts.reconnectionDelayMax,
  });
}

/** Drive a tick of the microtask queue. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// 1. Reconnection/backoff config
// ---------------------------------------------------------------------------

describe('broadcast client reconnection config', () => {
  it('passes explicit reconnection options through to the ioFactory', () => {
    let capturedOpts: Record<string, unknown> | undefined;
    const socket = createFakeSocket();

    new SocketIOBroadcastClient({
      url: 'http://127.0.0.1:0',
      ioFactory: (_url: string, opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return socket as unknown as RealSocket;
      },
      autoConnect: false,
      reconnection: false,
      reconnectionAttempts: 5,
      reconnectionDelay: 500,
      reconnectionDelayMax: 10000,
    });

    assert.ok(capturedOpts !== undefined);
    assert.equal(capturedOpts.reconnection, false, 'explicit reconnection false must reach io');
    assert.equal(capturedOpts.reconnectionAttempts, 5);
    assert.equal(capturedOpts.reconnectionDelay, 500);
    assert.equal(capturedOpts.reconnectionDelayMax, 10000);
  });

  it('provides sensible defaults for reconnection options', () => {
    let capturedOpts: Record<string, unknown> | undefined;
    const socket = createFakeSocket();

    new SocketIOBroadcastClient({
      url: 'http://127.0.0.1:0',
      ioFactory: (_url: string, opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return socket as unknown as RealSocket;
      },
      autoConnect: false,
    });

    assert.ok(capturedOpts !== undefined);
    assert.equal(capturedOpts.reconnection, true);
    assert.equal(capturedOpts.reconnectionAttempts, Infinity);
    assert.equal(capturedOpts.reconnectionDelay, 1000);
    assert.equal(capturedOpts.reconnectionDelayMax, 30000);
  });
});

// ---------------------------------------------------------------------------
// 2. Lifecycle hooks: onConnect / onReconnect / onDisconnect
// ---------------------------------------------------------------------------

describe('broadcast client lifecycle hooks', () => {
  it('fires onConnect on first connect and onReconnect on subsequent automatic reconnect', () => {
    const calls: string[] = [];
    const socket = createFakeSocket();
    makeClient(socket, {
      onConnect: () => calls.push('connect'),
      onReconnect: () => calls.push('reconnect'),
    });

    socket._triggerConnect();
    assert.deepEqual(calls, ['connect'], 'first connect fires onConnect only');

    socket._triggerDisconnect('transport close');
    socket._triggerConnect();
    assert.deepEqual(calls, ['connect', 'reconnect'], 'automatic reconnect fires onReconnect');
  });

  it('fires onConnect after manual disconnect then connect', () => {
    const calls: string[] = [];
    const socket = createFakeSocket();
    const client = makeClient(socket, {
      onConnect: () => calls.push('connect'),
      onReconnect: () => calls.push('reconnect'),
    });

    socket._triggerConnect();
    calls.length = 0;

    client.disconnect();
    client.connect();

    assert.deepEqual(
      calls,
      ['connect'],
      'manual disconnect+connect fires onConnect, not onReconnect',
    );
  });

  it('fires onDisconnect with the Socket.IO reason when the connection drops', () => {
    const reasons: (string | undefined)[] = [];
    const socket = createFakeSocket();
    makeClient(socket, {
      onDisconnect: (r) => reasons.push(r),
    });

    socket._triggerConnect();
    socket._triggerDisconnect('ping timeout');
    assert.deepEqual(reasons, ['ping timeout']);
  });
});

// ---------------------------------------------------------------------------
// 3. Transient vs permanent rejoin failure
// ---------------------------------------------------------------------------

describe('broadcast client rejoin failure', () => {
  it('keeps the channel desired on a transient rejoin failure and reports retryable', async () => {
    const socket = createFakeSocket();
    const errors: Error[] = [];
    const client = makeClient(socket, {
      onError: (e) => errors.push(e),
      autoConnect: false,
    });

    // First connect + subscribe successfully.
    socket._triggerConnect();
    let ackResolve: (() => void) | undefined;
    socket._captureSubscribeAck = (_channels, ack) => {
      ack({ ok: true });
      ackResolve?.();
    };
    const sub1Done = client.subscribe('room-1');
    await sub1Done;

    // Disconnect then automatic reconnect: triggers rejoin.
    // Respond with a transient failure.
    socket._triggerDisconnect('transport close');
    socket._captureSubscribeAck = (_channels, ack) => {
      ack({ ok: false, error: 'server error' });
    };
    socket._triggerConnect();
    await tick();

    // Error reported as retryable.
    assert.equal(errors.length, 1, 'transient failure must be reported');
    assert.match(errors[0]!.message, /server error/);
    const errExtra = errors[0] as unknown as { retryable?: boolean };
    assert.equal(errExtra.retryable, true, 'transient errors must carry retryable=true');

    // Channel must still be desired. Verify by subscribing to it again:
    // confirmed was cleared on disconnect; room-1 is still in desired but not
    // confirmed after a transient rejoin failure, so subscribe emits a request.
    let emittedChannels: string[] = [];
    socket._captureSubscribeAck = (channels, ack) => {
      emittedChannels = channels;
      ack({ ok: true });
    };
    await client.subscribe('room-1');
    assert.ok(
      emittedChannels.includes('room-1'),
      'channel must still be desired after transient rejoin failure',
    );
  });

  it('drops the channel on a permanent (unauthorized) rejoin denial', async () => {
    const socket = createFakeSocket();
    const errors: Error[] = [];
    const client = makeClient(socket, {
      onError: (e) => errors.push(e),
      autoConnect: false,
    });

    // Connect + subscribe successfully.
    socket._triggerConnect();
    socket._captureSubscribeAck = (_channels, ack) => {
      ack({ ok: true });
    };
    await client.subscribe('room-1');

    // Disconnect + automatic reconnect. Respond with permanent denial.
    socket._triggerDisconnect('transport close');
    socket._captureSubscribeAck = (_channels, ack) => {
      ack({ ok: false, error: 'unauthorized' });
    };
    socket._triggerConnect();
    await tick();

    // Channel must be dropped from desired. Subscribe again: if dropped,
    // subscribe adds it back and emits a request.
    let reRequested: string[] = [];
    socket._captureSubscribeAck = (channels, ack) => {
      reRequested = channels;
      ack({ ok: true });
    };
    await client.subscribe('room-1');
    assert.ok(
      reRequested.includes('room-1'),
      'channel must be dropped and re-requested after permanent denial',
    );

    // Permanent denial must NOT be retryable.
    const denialError = errors.find((e) => e.message === 'unauthorized');
    assert.ok(denialError, 'permanent denial must be reported');
    const denialExtra = denialError as unknown as { retryable?: boolean };
    assert.equal(denialExtra.retryable, undefined, 'permanent denial must not carry retryable');
  });
});

// ---------------------------------------------------------------------------
// 4. Connected-state accessor
// ---------------------------------------------------------------------------

describe('broadcast client connected state', () => {
  it('connected() reflects the socket connected state', () => {
    const socket = createFakeSocket();
    const client = makeClient(socket, { autoConnect: false });

    assert.equal(client.connected(), false, 'not connected before connect');
    socket._triggerConnect();
    assert.equal(client.connected(), true, 'connected() returns true after connect');
    socket._triggerDisconnect();
    assert.equal(client.connected(), false, 'connected() returns false after disconnect');
  });
});
