/**
 * Browser-safe Socket.IO client for the JSails broadcast channel.
 *
 * This module imports `socket.io-client` only — it must never import Redis,
 * `node:crypto`, or anything Node-specific, so it stays bundleable for the
 * browser. It connects to the same origin/path the server was mounted on,
 * uses the websocket transport only, and re-subscribes to its channels whenever
 * the connection is (re)established so the server re-runs authorization on every
 * reconnect.
 *
 * Protocol (must match `src/broadcast/server.ts`):
 * - client -> server: `jsails:subscribe`   `{ channels: string[] }`
 * - client -> server: `jsails:unsubscribe` `{ channels: string[] }`
 * - server -> client: `jsails:event`       `{ channel, event, data }`
 */

import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';

import type { JsonValue } from '../internal/json-safe.js';

import { BROADCAST_PATH } from './path.js';

export { BROADCAST_PATH };

const SUBSCRIBE_EVENT = 'jsails:subscribe';
const UNSUBSCRIBE_EVENT = 'jsails:unsubscribe';
const BROADCAST_EVENT = 'jsails:event';
const MAX_CHANNEL_NAME_LENGTH = 128;

/** A server-delivered broadcast payload. */
export interface BroadcastEvent {
  readonly channel: string;
  readonly event: string;
  readonly data: JsonValue;
}

/**
 * Extra properties attached to an error to signal whether a failed operation
 * can be retried. A {@link BroadcastClient} sets `retryable` on transient
 * rejoin failures so callers can distinguish them from permanent denials.
 */
export interface BroadcastClientError extends Error {
  readonly retryable?: true;
}

interface BroadcastClientOptions {
  /** Server origin. Defaults to the browser's `window.location.origin`. */
  url?: string;
  /** Engine.IO path; must match the server. Defaults to `/_jsails/broadcast`. */
  path?: string;
  /** Transports. Defaults to `['websocket']`. */
  transports?: string[];
  /**
   * Forwarded to Socket.IO's `auth`. Untrusted by the server (identity comes
   * from its own `authenticate` callback); a function form is re-invoked on
   * reconnect and can be used to attach a fresh token.
   */
  auth?: Record<string, unknown> | ((cb: (data: Record<string, unknown>) => void) => void);
  /** Extra headers (e.g. `Authorization`) for header-based authentication. */
  extraHeaders?: Record<string, string>;
  /** Connect immediately. Defaults to `true`. */
  autoConnect?: boolean;

  // --- Reconnection (explicitly configured — no reliance on implicit defaults) ---

  /** Enable automatic reconnection. Defaults to `true`. */
  reconnection?: boolean;
  /** Maximum reconnection attempts before giving up. Defaults to `Infinity`. */
  reconnectionAttempts?: number;
  /** Initial delay in milliseconds before the first reconnection attempt. Defaults to `1000`. */
  reconnectionDelay?: number;
  /** Maximum delay in milliseconds between reconnection attempts. Defaults to `30000`. */
  reconnectionDelayMax?: number;

  // --- Lifecycle hooks ---

  /** Fired on the first successful connection or after a manual disconnect + connect. */
  onConnect?: () => void;
  /** Fired after an automatic reconnection (not on the first connect). */
  onReconnect?: () => void;
  /** Fired when the socket disconnects, with the Socket.IO reason string. */
  onDisconnect?: (reason?: string) => void;

  /** Invoked when an asynchronous operation fails. Rejoin denials carry a
   * `retryable` property to distinguish transient from permanent failures. */
  onError?: (error: Error) => void;

  // --- Testing seam ---

  /** Injectable Socket.IO factory for tests. Defaults to the real `io`. */
  ioFactory?: (url: string, options: Record<string, unknown>) => Socket;
}

export interface BroadcastClient {
  /** Join one or more channels. Resolves once the server confirms membership. */
  subscribe(channels: string | string[]): Promise<void>;
  /** Leave one or more channels. Resolves once the server confirms the leave. */
  unsubscribe(channels: string | string[]): Promise<void>;
  /** Register a listener for broadcast events; returns an unregister function. */
  onEvent(listener: (event: BroadcastEvent) => void): () => void;
  /** (Re)connect. Re-subscribes to all desired channels on connect. */
  connect(): void;
  /** Disconnect; the client does not auto-reconnect after this call. */
  disconnect(): void;
  /** Alias of {@link disconnect}. */
  close(): void;
  /** Whether the underlying socket is currently connected. */
  connected(): boolean;
}

interface SubscribeResponse {
  ok: boolean;
  error?: string;
}

/** Resolve the server origin, defaulting to the browser's own origin. */
function defaultOrigin(): string {
  const scope = globalThis as { location?: { origin?: string } };
  const origin = scope.location?.origin;
  if (origin !== undefined && origin !== '') {
    return origin;
  }
  throw new Error('BroadcastClient requires a `url` option outside of a browser');
}

/** Validate and deduplicate a channel list into unique non-empty names. */
function normalizeChannels(input: string | string[]): string[] {
  const list = Array.isArray(input) ? input : [input];
  const channels = [...new Set(list)];
  for (const channel of channels) {
    if (
      typeof channel !== 'string' ||
      channel.length === 0 ||
      channel.length > MAX_CHANNEL_NAME_LENGTH
    ) {
      throw new TypeError('channel must be a non-empty string within the configured length');
    }
  }
  return channels;
}

type PendingEntry = { resolve: () => void; reject: (error: Error) => void };

export class SocketIOBroadcastClient implements BroadcastClient {
  #socket: Socket;
  #desired: Set<string>;
  #confirmed: Set<string>;
  #subscribeSeq: number;
  #pending: Map<number, PendingEntry>;

  #wasEverConnected: boolean;
  #manualDisconnect: boolean;

  #onConnect: (() => void) | undefined;
  #onReconnect: (() => void) | undefined;
  #onDisconnect: ((reason?: string) => void) | undefined;
  #onError: ((error: Error) => void) | undefined;

  constructor(options: BroadcastClientOptions = {}) {
    const url = options.url ?? defaultOrigin();
    const path = options.path ?? BROADCAST_PATH;

    const realIo = options.ioFactory ?? io;

    this.#onConnect = options.onConnect;
    this.#onReconnect = options.onReconnect;
    this.#onDisconnect = options.onDisconnect;
    this.#onError = options.onError;

    this.#socket = realIo(url, {
      path,
      transports: options.transports ?? ['websocket'],
      autoConnect: options.autoConnect ?? true,
      auth: options.auth,
      extraHeaders: options.extraHeaders,
      reconnection: options.reconnection ?? true,
      reconnectionAttempts: options.reconnectionAttempts ?? Infinity,
      reconnectionDelay: options.reconnectionDelay ?? 1000,
      reconnectionDelayMax: options.reconnectionDelayMax ?? 30000,
    });

    this.#desired = new Set<string>();
    this.#confirmed = new Set<string>();
    this.#subscribeSeq = 0;
    this.#pending = new Map<number, PendingEntry>();
    this.#wasEverConnected = false;
    this.#manualDisconnect = false;

    this.#socket.on('connect', () => {
      if (this.#manualDisconnect) {
        this.#manualDisconnect = false;
        this.#onConnect?.();
      } else if (this.#wasEverConnected) {
        this.#onReconnect?.();
      } else {
        this.#wasEverConnected = true;
        this.#onConnect?.();
      }
      this.#rejoin();
    });

    this.#socket.on('disconnect', (reason: string) => {
      this.#confirmed.clear();
      for (const entry of this.#pending.values()) {
        entry.reject(new Error('disconnected before subscription was confirmed'));
      }
      this.#pending.clear();

      if (reason === 'io client disconnect') {
        this.#manualDisconnect = true;
      }

      this.#onDisconnect?.(reason);
    });

    this.#socket.on('connect_error', (error: Error) => {
      this.#reportError(error);
    });
  }

  #reportError(error: Error): void {
    this.#onError?.(error);
  }

  #requestSubscribe(channels: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const seq = this.#subscribeSeq;
      this.#subscribeSeq += 1;
      this.#pending.set(seq, { resolve, reject });
      this.#socket.emit(SUBSCRIBE_EVENT, { channels }, (response: SubscribeResponse) => {
        const entry = this.#pending.get(seq);
        if (entry === undefined) {
          return;
        }
        this.#pending.delete(seq);
        if (response?.ok === true) {
          for (const channel of channels) {
            this.#confirmed.add(channel);
          }
          entry.resolve();
        } else {
          const error = new Error(response?.error ?? 'unauthorized') as BroadcastClientError;
          for (const channel of channels) {
            this.#desired.delete(channel);
            this.#confirmed.delete(channel);
          }
          entry.reject(error);
          this.#reportError(error);
        }
      });
    });
  }

  /**
   * Re-join every desired channel not yet confirmed (fires on connect/reconnect).
   * Transient failures (anything other than `'unauthorized'`) keep the channel
   * desired so the next reconnect retries; permanent denials drop it.
   */
  #rejoin(): void {
    const channels = [...this.#desired].filter((channel) => !this.#confirmed.has(channel));
    if (channels.length === 0) {
      return;
    }
    this.#socket.emit(SUBSCRIBE_EVENT, { channels }, (response: SubscribeResponse) => {
      if (response?.ok === true) {
        for (const channel of channels) {
          this.#confirmed.add(channel);
        }
      } else {
        const errorMsg = response?.error ?? 'server error';
        const isPermanent = errorMsg === 'unauthorized';
        const error: BroadcastClientError = Object.assign(new Error(errorMsg), {
          ...(isPermanent ? {} : { retryable: true as const }),
        });
        if (isPermanent) {
          for (const channel of channels) {
            this.#desired.delete(channel);
            this.#confirmed.delete(channel);
          }
        }
        this.#reportError(error);
      }
    });
  }

  subscribe(channels: string | string[]): Promise<void> {
    const list = normalizeChannels(channels);
    for (const channel of list) {
      this.#desired.add(channel);
    }
    const toRequest = list.filter((channel) => !this.#confirmed.has(channel));
    if (toRequest.length === 0) {
      return Promise.resolve();
    }
    return this.#requestSubscribe(toRequest);
  }

  unsubscribe(channels: string | string[]): Promise<void> {
    const list = normalizeChannels(channels);
    for (const channel of list) {
      this.#desired.delete(channel);
      this.#confirmed.delete(channel);
    }
    if (list.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.#socket.emit(UNSUBSCRIBE_EVENT, { channels: list }, (response: SubscribeResponse) => {
        if (response?.ok === true) {
          resolve();
        } else {
          reject(new Error(response?.error ?? 'invalid-request'));
        }
      });
    });
  }

  onEvent(listener: (event: BroadcastEvent) => void): () => void {
    const handler = (payload: BroadcastEvent): void => {
      listener(payload);
    };
    this.#socket.on(BROADCAST_EVENT, handler);
    return () => {
      this.#socket.off(BROADCAST_EVENT, handler);
    };
  }

  connect(): void {
    this.#socket.connect();
  }

  disconnect(): void {
    this.#socket.disconnect();
  }

  close(): void {
    this.disconnect();
  }

  connected(): boolean {
    return this.#socket.connected;
  }
}
