/**
 * SignalBus: a service-layer wrapper over the shared interceptor/observer
 * registry. It exposes only the event-observer subset (no before/after
 * operation interceptors) so consumers see a narrow, typed signal surface.
 *
 * A SignalBus wraps the *shared* {@link InterceptorRegistry} created by
 * {@link runExtensions}, not a local one. This means an observer registered
 * by one plugin fires when any other plugin emits the same event through the
 * bus — the registry is the single source of truth.
 */

import {
  type EventToken,
  type InterceptorRegistry,
  type Observer,
} from '../extensions/interceptors.js';

/** The service surface: observe an event or emit a signal. */
export interface SignalBus {
  /** Register a fire-and-forget observer for `event`. Only valid during setup. */
  observe<TPayload>(event: EventToken<TPayload>, fn: Observer<TPayload>): void;

  /** Emit `payload` to every observer of `event`; returns isolated errors. */
  emit<TPayload>(event: EventToken<TPayload>, payload: TPayload): Promise<readonly unknown[]>;
}

/** Raised when the shared interceptor registry is unavailable. Value-free. */
export class SignalError extends Error {
  readonly code: 'registry_unavailable';

  constructor(message: string) {
    super(message);
    this.name = 'SignalError';
    this.code = 'registry_unavailable';
  }
}

/**
 * A {@link SignalBus} backed by the shared {@link InterceptorRegistry}. It adds
 * no buffering, no durability, and no removal API; the registry's own seal
 * guard applies to `observe` calls after setup.
 *
 * An absent or invalid registry raises a value-free {@link SignalError} at
 * construction time (defensive guard for callers that may receive `undefined`
 * from a missing context member).
 */
export class RegistrySignalBus implements SignalBus {
  readonly #registry: InterceptorRegistry;

  constructor(registry: InterceptorRegistry) {
    if (!registry || typeof registry.observe !== 'function') {
      throw new SignalError(
        'shared interceptor registry is unavailable — ensure the signals plugin is ' +
          'run inside a framework that exposes the shared registry on the setup context',
      );
    }
    this.#registry = registry;
  }

  observe<TPayload>(event: EventToken<TPayload>, fn: Observer<TPayload>): void {
    // Delegates directly; registry.observe throws InterceptorError('sealed')
    // after setup, which is the exact desired behaviour.
    this.#registry.observe(event, fn);
  }

  emit<TPayload>(event: EventToken<TPayload>, payload: TPayload): Promise<readonly unknown[]> {
    return this.#registry.emit(event, payload);
  }
}
