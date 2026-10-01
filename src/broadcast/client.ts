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

export const BROADCAST_PATH = '/_jsails/broadcast';

const SUBSCRIBE_EVENT = 'jsails:subscribe';
const UNSUBSCRIBE_EVENT = 'jsails:unsubscribe';
const BROADCAST_EVENT = 'jsails:event';
const MAX_CHANNEL_NAME_LENGTH = 128;

/** A JSON-compatible value (mirrors the server's `JsonValue`). */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A server-delivered broadcast payload. */
export interface BroadcastEvent {
  readonly channel: string;
  readonly event: string;
  readonly data: JsonValue;
}

export interface BroadcastClientOptions {
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
  /** Invoked when an asynchronous operation fails (e.g. a re-join is denied). */
  onError?: (error: Error) => void;
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

export function createBroadcastClient(options: BroadcastClientOptions = {}): BroadcastClient {
  const url = options.url ?? defaultOrigin();
  const path = options.path ?? BROADCAST_PATH;

  const socket: Socket = io(url, {
    path,
    transports: options.transports ?? ['websocket'],
    autoConnect: options.autoConnect ?? true,
    auth: options.auth,
    extraHeaders: options.extraHeaders,
  });

  const desired = new Set<string>();
  const confirmed = new Set<string>();
  let subscribeSeq = 0;
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();

  function reportError(error: Error): void {
    options.onError?.(error);
  }

  function requestSubscribe(channels: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const seq = subscribeSeq;
      subscribeSeq += 1;
      pending.set(seq, { resolve, reject });
      socket.emit(SUBSCRIBE_EVENT, { channels }, (response: SubscribeResponse) => {
        const entry = pending.get(seq);
        if (entry === undefined) {
          return;
        }
        pending.delete(seq);
        if (response?.ok === true) {
          for (const channel of channels) {
            confirmed.add(channel);
          }
          entry.resolve();
        } else {
          const error = new Error(response?.error ?? 'unauthorized');
          for (const channel of channels) {
            desired.delete(channel);
            confirmed.delete(channel);
          }
          entry.reject(error);
          reportError(error);
        }
      });
    });
  }

  /** Re-join every desired channel not yet confirmed (fires on connect). */
  function rejoin(): void {
    const channels = [...desired].filter((channel) => !confirmed.has(channel));
    if (channels.length === 0) {
      return;
    }
    socket.emit(SUBSCRIBE_EVENT, { channels }, (response: SubscribeResponse) => {
      if (response?.ok === true) {
        for (const channel of channels) {
          confirmed.add(channel);
        }
      } else {
        const error = new Error(response?.error ?? 'unauthorized');
        for (const channel of channels) {
          desired.delete(channel);
          confirmed.delete(channel);
        }
        reportError(error);
      }
    });
  }

  socket.on('connect', rejoin);

  socket.on('disconnect', () => {
    // Server-side membership is gone; keep `desired` so a reconnect re-joins.
    confirmed.clear();
    for (const entry of pending.values()) {
      entry.reject(new Error('disconnected before subscription was confirmed'));
    }
    pending.clear();
  });

  socket.on('connect_error', (error: Error) => {
    reportError(error);
  });

  function subscribe(channels: string | string[]): Promise<void> {
    const list = normalizeChannels(channels);
    for (const channel of list) {
      desired.add(channel);
    }
    const toRequest = list.filter((channel) => !confirmed.has(channel));
    if (toRequest.length === 0) {
      return Promise.resolve();
    }
    return requestSubscribe(toRequest);
  }

  function unsubscribe(channels: string | string[]): Promise<void> {
    const list = normalizeChannels(channels);
    for (const channel of list) {
      desired.delete(channel);
      confirmed.delete(channel);
    }
    if (list.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      socket.emit(UNSUBSCRIBE_EVENT, { channels: list }, (response: SubscribeResponse) => {
        if (response?.ok === true) {
          resolve();
        } else {
          reject(new Error(response?.error ?? 'invalid-request'));
        }
      });
    });
  }

  function onEvent(listener: (event: BroadcastEvent) => void): () => void {
    const handler = (payload: BroadcastEvent): void => {
      listener(payload);
    };
    socket.on(BROADCAST_EVENT, handler);
    return () => {
      socket.off(BROADCAST_EVENT, handler);
    };
  }

  function connect(): void {
    socket.connect();
  }

  function disconnect(): void {
    socket.disconnect();
  }

  return {
    subscribe,
    unsubscribe,
    onEvent,
    connect,
    disconnect,
    close: disconnect,
  };
}
