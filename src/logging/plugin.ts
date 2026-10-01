/**
 * First-party `logger` plugin: exposes a {@link Logger} service under a typed
 * service token.
 *
 * `loggerPlugin(options?)` builds a {@link JsailsPlugin} named `logger` whose
 * `setup` calls {@link createLogger} with the given options and provides the
 * result under {@link loggerToken}.
 *
 * Construction is inert — no I/O, no `process` access, no connection until a
 * log method is called. Options are passed through to `createLogger` and
 * validated eagerly during `setup` (invalid options throw `LoggerError` or
 * `TypeError` at that point).
 *
 * Cleanup is a no-op, so the runner's `close` stays idempotent.
 */

import { definePlugin, type JsailsPlugin } from '../extensions/plugin-contract.js';
import { createServiceToken, type ServiceToken } from '../extensions/services.js';
import { createLogger } from './logger.js';
import type { LogChannel } from './types.js';
import type { Logger } from './types.js';

// Diagnostics and signals are imported as `type` so the plugin module never
// pulls in their full runtime modules.
import type { DiagnosticsRecorder } from '../diagnostics/recorder.js';
import type { SignalBus } from '../signals/signal-bus.js';

/**
 * Opaque token for the application {@link Logger}. Defined once here and shared
 * by the provider (`loggerPlugin`) and any consumer (e.g. an extension's
 * `requires`).
 */
export const loggerToken: ServiceToken<Logger> = createServiceToken<Logger>('logger');

/** Options accepted by {@link loggerPlugin}. Mirrors {@link LoggerOptions}. */
export interface LoggerPluginOptions {
  /** Channels to write to on every log call. Passed through to the logger. */
  readonly channels?: readonly LogChannel[];
  /** Clock returning milliseconds since epoch. Passed through to the logger. */
  readonly clock?: () => number;
  /** Optional diagnostics recorder forwarded to the logger. */
  readonly diagnostics?: DiagnosticsRecorder;
  /** Optional signal bus forwarded to the logger. */
  readonly signals?: SignalBus;
}

/**
 * Build the first-party `logger` plugin. Construction is inert — no I/O, no
 * `process` access, and no log record is written until a log method is called.
 *
 * Options are passed through to {@link createLogger} and validated eagerly
 * during `setup`. Invalid options throw `LoggerError` (or `TypeError`) at that
 * point rather than silently degrading.
 */
export function loggerPlugin(options?: LoggerPluginOptions): JsailsPlugin {
  return definePlugin({
    name: 'logger',
    setup({ services }) {
      services.provide(loggerToken, createLogger(options));
    },
  });
}
