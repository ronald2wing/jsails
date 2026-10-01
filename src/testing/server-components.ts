/**
 * Server-component test harness (`createComponentTestHarness`).
 *
 * An in-process harness over the real server-component runtime that mounts a
 * component and drives updates without listening on a port, hand-rolling an
 * HTTP fixture, or extracting snapshot/CSRF tokens from SSR HTML. Every call
 * goes through {@link createServerComponentsRuntime} and
 * {@link createComponentSigner} directly — no Hono app is built.
 *
 * The harness is stateless across calls: each `render` mints a new component
 * instance, and each `update` verifies the snapshot and returns a re-signed
 * result through the same runtime path a real POST takes.
 */

import {
  COMPONENT_CSRF_ATTRIBUTE,
  COMPONENT_CSRF_HEADER,
  COMPONENT_SNAPSHOT_ATTRIBUTE,
} from '../server-components/protocol.js';
import { createServerComponentsRuntime } from '../server-components/runtime.js';
import { createComponentSigner } from '../server-components/snapshot.js';
import { createRequestContext } from '../server/request-pipeline.js';

import type { ServerComponentDefinition } from '../server-components/component.js';
import type { Session, RequestContext } from '../contracts/http.js';
import type { TestingLifecycle } from './app.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Deterministic test key used when no `signingKey` is supplied, so every test
 * run produces identical snapshots without relying on `NODE_ENV`.
 */
const DEFAULT_TEST_KEY = '0123456789abcdef0123456789abcdef';

/** Origin used when neither `origin` nor `publicOrigin` is configured. */
const DEFAULT_ORIGIN = 'http://localhost';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for {@link createComponentTestHarness}. */
export interface ComponentTestHarnessOptions {
  /** Registered components keyed by name (required). */
  readonly components: Readonly<Record<string, ServerComponentDefinition<any>>>;
  /** Signing key. When omitted a deterministic test key is used. */
  readonly signingKey?: string;
  /** Trusted origin (default `http://localhost`). */
  readonly origin?: string;
  /** Session to bind the component to (default `null`). */
  readonly session?: Session | null;
  /** Auto-close registration surface (e.g. a `node:test` `t`). */
  readonly lifecycle?: TestingLifecycle;
}

/** The result of {@link ComponentTestHarness.render}. */
export interface ComponentRenderResult {
  /** The SSR HTML produced by the component's `render`. */
  readonly html: string;
  /** The signed snapshot token extracted from the rendered root. */
  readonly snapshot: string;
  /** The CSRF token extracted from the rendered root. */
  readonly csrf: string;
}

/** The result of {@link ComponentTestHarness.update}. */
export interface ComponentUpdateTestResult {
  /** HTTP status code (200 on success, 403/422/500 on failure). */
  readonly status: number;
  /** The parsed response body (the runtime's {@link ServerComponentUpdateResult}). */
  readonly body: unknown;
  /** Re-signed snapshot token, present only on success. */
  readonly snapshot?: string;
  /** Re-rendered component HTML, present on success or a validation error. */
  readonly html?: string;
}

/** The handle returned by {@link createComponentTestHarness}. */
export interface ComponentTestHarness {
  render(name: string): Promise<ComponentRenderResult>;
  update(
    snapshot: string,
    updates: Record<string, unknown>,
    options?: ComponentUpdateOptions,
  ): Promise<ComponentUpdateTestResult>;
  close(): Promise<void>;
}

/** Options for {@link ComponentTestHarness.update}. */
export interface ComponentUpdateOptions {
  /** CSRF token (required for a session-bound component; defaults to the signed snapshot id). */
  readonly csrf?: string;
  /** Trusted origin (defaults to the harness's origin). */
  readonly origin?: string;
  /** An optional action to run alongside client edits. */
  readonly action?: {
    readonly name: string;
    readonly args?: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract an attribute value from an HTML string, or throw if absent. */
function extractAttr(html: string, name: string): string {
  const match = html.match(new RegExp(`${name}="([^"]*)"`));
  if (match === null) {
    throw new Error(`expected attribute ${name} in HTML`);
  }
  return match[1]!;
}

/**
 * Build a minimal {@link Request} for a component render (GET).
 * The runtime reads `context.url` for route params and origin derivation.
 */
function renderRequest(url: URL): Request {
  return new Request(url, { method: 'GET' });
}

/**
 * Build a minimal {@link Request} for a component update (POST).
 * The runtime reads `Origin` (same-origin check) and `X-CSRF-Token` (CSRF
 * check) from the request headers.
 */
function updateRequest(url: URL, origin: string, csrf: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: { origin, [COMPONENT_CSRF_HEADER]: csrf },
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an in-process test harness over the real server-component runtime.
 *
 * The harness builds a {@link ComponentSigner} and a
 * {@link ServerComponentsRuntime} from the supplied components, then exposes
 * `render` and `update` methods that build a {@link RequestContext} and call
 * the runtime directly — no HTTP server, Hono app, or browser is involved.
 *
 * When `lifecycle` is supplied the harness registers an `after` callback that
 * calls `close()`, so the harness tears down idempotently when the test
 * finishes.
 */
export function createComponentTestHarness(
  options: ComponentTestHarnessOptions,
): ComponentTestHarness {
  const key = options.signingKey ?? DEFAULT_TEST_KEY;
  const origin = options.origin ?? DEFAULT_ORIGIN;
  const session = options.session ?? null;

  const signer = createComponentSigner({ key });
  const runtime = createServerComponentsRuntime({
    components: options.components,
    signer,
  });

  let closed = false;

  /** Build a {@link RequestContext} suitable for render or update. */
  function buildContext(req: Request, params: Record<string, string> = {}): RequestContext {
    return createRequestContext({
      request: req,
      url: new URL(req.url),
      params,
      session,
    });
  }

  async function render(name: string): Promise<ComponentRenderResult> {
    if (closed) {
      throw new Error('component test harness is closed');
    }
    const mountUrl = new URL(`/${name}`, origin);
    const context = buildContext(renderRequest(mountUrl), { component: name });
    const html = await runtime.render(name, context, { origin });

    return {
      html,
      snapshot: extractAttr(html, COMPONENT_SNAPSHOT_ATTRIBUTE),
      csrf: extractAttr(html, COMPONENT_CSRF_ATTRIBUTE),
    };
  }

  async function update(
    snapshot: string,
    updates: Record<string, unknown>,
    updateOptions: ComponentUpdateOptions = {},
  ): Promise<ComponentUpdateTestResult> {
    if (closed) {
      throw new Error('component test harness is closed');
    }

    const effectiveOrigin = updateOptions.origin ?? origin;
    const updateUrl = new URL('/_jsails/components/update', effectiveOrigin);
    const effectiveCsrf = updateOptions.csrf ?? '';

    const req = updateRequest(updateUrl, effectiveOrigin, effectiveCsrf);
    const context = buildContext(req);

    const payload: Record<string, unknown> = { snapshot, updates, sequence: 1 };
    if (updateOptions.action !== undefined) {
      payload.action = updateOptions.action;
    }

    const result = await runtime.update(payload, context, { origin: effectiveOrigin });

    // Route through `unknown` so components with optional fields on a readonly
    // interface can be inspected dynamically without TS index-signature noise.
    const body = result.body as unknown as Record<string, unknown>;
    const html = typeof body.html === 'string' ? body.html : undefined;
    const reSigned = typeof body.snapshot === 'string' ? body.snapshot : undefined;

    return { status: result.status, body: result.body, snapshot: reSigned, html };
  }

  async function close(): Promise<void> {
    if (closed) {
      return;
    }
    closed = true;
    runtime.close();
  }

  if (options.lifecycle !== undefined) {
    options.lifecycle.after(() => close());
  }

  return { render, update, close };
}
