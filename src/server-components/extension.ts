/**
 * Server-components extension: the application-facing seam that binds the
 * transport runtime to a service token and hands page authors a render helper.
 *
 * `serverComponents({ components, signingKey? })` returns a plain
 * {@link JsailsExtension}. Its `setup` builds a {@link ServerComponentsRuntime}
 * over a lazy snapshot signer and provides it under {@link SERVER_COMPONENTS};
 * the teardown closes the runtime. The signer is lazy on purpose: the key is
 * resolved only when a live render or update actually signs/verifies a
 * snapshot, so a static export never needs a key.
 *
 * Key resolution precedence, evaluated lazily on first signature:
 * 1. an explicit `signingKey`;
 * 2. the `JSAILS_COMPONENT_SECRET` environment variable;
 * 3. a fresh random key only when `NODE_ENV` is exactly `development` or `test`;
 * 4. an explicit {@link ServerComponentsError} otherwise (missing key), so an
 *    unset, `staging`, or `production` environment fails a live render closed.
 *
 * `renderServerComponent(name, context)` is the page-author helper: it resolves
 * the runtime from `context.services` and renders the component to a Preact
 * host element carrying the trusted HTML. `renderServerComponentHtml` returns
 * the same HTML as a string for custom renderers or non-Preact hosts. Both
 * honor `context.renderMode` (static renders only the fallback) and bind the
 * snapshot origin to `context.publicOrigin` when present.
 */

import { randomBytes } from 'node:crypto';

import { h } from 'preact';
import type { VNode } from 'preact';

import type { RequestContext } from '../contracts/http.js';
import type { JsailsExtension } from '../extensions/extension.js';
import { createServiceToken } from '../extensions/services.js';
import type { ServerComponentDefinition } from './component.js';
import { createServerComponentsRuntime } from './runtime.js';
import type { ServerComponentsRuntime } from './runtime.js';
import { createComponentSigner } from './snapshot.js';
import type { ComponentSigner } from './snapshot.js';

/** Service token the extension registers its runtime under. */
export const SERVER_COMPONENTS = createServiceToken<ServerComponentsRuntime>('server-components');

/** Environment variable holding the snapshot key when `signingKey` is omitted. */
export const COMPONENT_SECRET_ENV = 'JSAILS_COMPONENT_SECRET';

/** Minimum signing-key length in bytes (256 bits), mirrored from the signer. */
const MIN_SIGNING_KEY_BYTES = 32;

/** Raised for extension wiring failures (missing key, missing runtime). Value-free. */
export class ServerComponentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerComponentsError';
  }
}

/** Options for {@link serverComponents}. */
export interface ServerComponentsOptions {
  /** Registered components keyed by name. */
  readonly components: Readonly<Record<string, ServerComponentDefinition<any>>>;
  /**
   * Snapshot signing key (>= 32 bytes). When omitted, the extension resolves a
   * key from {@link COMPONENT_SECRET_ENV}, then a fresh random key only in
   * `development`/`test`, and otherwise fails a live render.
   */
  readonly signingKey?: string | Uint8Array;
}

/**
 * Build the server-components extension. The components map and signer are
 * wired into the runtime during `setup`, so nothing signs or runs a component
 * callback until a live render/update actually happens.
 */
export function serverComponents(options: ServerComponentsOptions): JsailsExtension {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('serverComponents requires an options object');
  }
  const components = options.components;
  if (components === null || typeof components !== 'object' || Array.isArray(components)) {
    throw new TypeError('components must be a plain object of server component definitions');
  }
  if (options.signingKey !== undefined) {
    assertKeyLength(options.signingKey);
  }

  const resolveKey = makeKeyResolver(options);

  return {
    name: 'server-components',
    setup({ services }) {
      const runtime = createServerComponentsRuntime({
        components,
        signer: createLazySigner(resolveKey),
      });
      services.provide(SERVER_COMPONENTS, runtime);
      return () => runtime.close();
    },
  };
}

/**
 * Resolve the signing key, honoring the explicit key, then the environment,
 * then a development/test-only random key. Throws when no key is available in
 * any other environment (including an unset `NODE_ENV`); the call is deferred
 * until the first signature via the lazy signer.
 */
function makeKeyResolver(options: ServerComponentsOptions): () => string | Uint8Array {
  return () => {
    if (options.signingKey !== undefined) {
      return options.signingKey;
    }
    const env = process.env[COMPONENT_SECRET_ENV];
    if (env !== undefined && env !== '') {
      return env;
    }
    const nodeEnv = process.env.NODE_ENV;
    if (nodeEnv === 'development' || nodeEnv === 'test') {
      return randomBytes(MIN_SIGNING_KEY_BYTES);
    }
    throw new ServerComponentsError(
      'server components require a signing key when NODE_ENV is not ' +
        `development/test: set ${COMPONENT_SECRET_ENV} or pass signingKey`,
    );
  };
}

/** Reject an undersized key up front so a bad config fails before serving. */
function assertKeyLength(key: string | Uint8Array): void {
  const bytes = typeof key === 'string' ? Buffer.byteLength(key, 'utf8') : key.byteLength;
  if (bytes < MIN_SIGNING_KEY_BYTES) {
    throw new ServerComponentsError('server components signing key must be at least 32 bytes');
  }
}

/**
 * A signer facade that satisfies the runtime's shape contract without resolving
 * the key. The underlying signer (and therefore the key) is created on the
 * first `subjectFor`/`sign`/`verify` call, so static-only renders never touch
 * the key or the crypto construction.
 */
function createLazySigner(resolveKey: () => string | Uint8Array): ComponentSigner {
  let signer: ComponentSigner | undefined;
  const ensure = (): ComponentSigner => {
    if (signer === undefined) {
      signer = createComponentSigner({ key: resolveKey() });
    }
    return signer;
  };
  return {
    subjectFor(id) {
      return ensure().subjectFor(id);
    },
    sign(payload) {
      return ensure().sign(payload);
    },
    verify(token, options) {
      return ensure().verify(token, options);
    },
  };
}

/**
 * Render a server component to a Preact host element whose `dangerouslySetInnerHTML`
 * carries the component's trusted HTML. The host element is a plain wrapper
 * (the runtime already emits the marked, signed component root inside it).
 */
export async function renderServerComponent(
  name: string,
  context: RequestContext,
): Promise<VNode<any>> {
  const html = await renderServerComponentHtml(name, context);
  return h('div', { dangerouslySetInnerHTML: { __html: html } });
}

/**
 * Render a server component to its raw HTML string, for custom renderers or
 * non-Preact hosts. Honors `context.renderMode` (static renders only the
 * author's `staticFallback`, never signing) and binds the snapshot origin to
 * `context.publicOrigin` when the app configured one.
 */
export async function renderServerComponentHtml(
  name: string,
  context: RequestContext,
): Promise<string> {
  const runtime = requireRuntime(context);
  return runtime.render(name, context, {
    staticMode: context.renderMode === 'static',
    ...(context.publicOrigin === undefined ? {} : { origin: context.publicOrigin }),
  });
}

/** Resolve the registered runtime from the request context's service registry. */
function requireRuntime(context: RequestContext): ServerComponentsRuntime {
  const services = context.services;
  if (services === undefined) {
    throw new ServerComponentsError('server components are not available in this context');
  }
  let runtime: ServerComponentsRuntime | undefined;
  try {
    runtime = services.tryGet(SERVER_COMPONENTS);
  } catch {
    runtime = undefined;
  }
  if (runtime === undefined) {
    throw new ServerComponentsError('server components runtime is not registered');
  }
  return runtime;
}
