/**
 * Signals: a service-layer signal bus over the shared interceptor/observer
 * registry, plus a first-party plugin that provides it under a typed token.
 *
 * {@link createSignalBus} wraps the shared registry; {@link signalsPlugin} is
 * the first-party extension that exposes the bus under {@link signalsToken}.
 */

export { createSignalBus, SignalError, type SignalBus } from './signal-bus.js';
export { signalsPlugin, signalsToken } from './plugin.js';
export {
  requestFailed,
  requestFinished,
  requestStarted,
  type RequestSignalPayload,
} from './request-signals.js';

// The `signals` factory is the subpath's default export, matching every other
// first-party plugin subpath: `plugins.use` resolves a specifier by importing
// the default export and calling it with the options tuple.
export { signalsPlugin as default } from './plugin.js';
