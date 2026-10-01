/**
 * Nested (child) server components for JSails.
 *
 * A parent component may render an independently authorised, stateful child
 * component inside its own render output. Each child carries its own signed
 * snapshot token, CSRF marker, and component id — its state is fully
 * independent and the child re-verifies its own snapshot on every update,
 * re-runs its own `authorize`, and enforces its own `writableKeys`. A parent
 * never inherits, proxies, or weakens a child's security boundary.
 *
 * Security posture:
 * - Nested state is independent: each child is rendered (and updated) through
 *   its own `mount` → `sign` → `verify` lifecycle. A valid child snapshot is
 *   bound to the child's component name and the request's origin + subject,
 *   not the parent's.
 * - A child whose `authorize` returns anything but exactly `true` for the
 *   current request is denied, and `renderNested` throws a value-free
 *   {@link NestedComponentError}.
 * - There is no parent-to-child state leakage: `renderNested` calls the
 *   runtime's `render`, which produces the child's initial state from the
 *   child's own `initialState`, never from parent state.
 * - Nesting depth is bounded at construction time by {@link MAX_NESTING_DEPTH}
 *   (decorative story only; the runtime does not enforce depth).
 */

import { h } from 'preact';
import type { VNode } from 'preact';

import type { RequestContext } from '../contracts/http.js';
import {
  ServerComponentError,
  renderServerComponentHtml,
  serverComponentsToken,
} from './extension.js';
import { ServerComponentRuntimeError } from './runtime.js';

/**
 * Configuration for a nested (child) component, returned by
 * {@link defineNestedComponent}.
 *
 * The config is a frozen plain object carrying only display metadata — the
 * component name is the registered server-component the child renders, `tag`
 * names the wrapper element, and `key` is an optional stable identifier (a
 * decorative story for SSR, not a runtime tracking mechanism).
 */
export interface NestedComponentConfig {
  /** The tag name the child renders its root element as. */
  readonly tag: string;
  /** The registered server-component name. */
  readonly component: string;
  /** An optional stable key for the child wrapper. */
  readonly key?: string;
}

/** Maximum advice depth for nested render; decorative, not enforced. */
export const MAX_NESTING_DEPTH = 8;

/** Raised for nested-component wiring failures. Value-free. */
export class NestedComponentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NestedComponentError';
  }
}

/**
 * Define a nested component configuration.
 *
 * `tag` is the HTML wrapper element (e.g. `"section"`, `"div"`). `component`
 * must name a registered server component. `key` is an optional stable
 * identifier placed on the wrapper as `data-nested-key`.
 *
 * The returned config is frozen; pass it to {@link renderNested} to render
 * the child inside a parent's output, or pass just the component name as a
 * string for the default `div` wrapper.
 */
export function defineNestedComponent(config: {
  readonly name: string;
  readonly component: string;
  readonly key?: string;
}): NestedComponentConfig {
  if (config === null || typeof config !== 'object') {
    throw new NestedComponentError('defineNestedComponent requires a config object');
  }
  if (typeof config.component !== 'string' || config.component.trim() === '') {
    throw new NestedComponentError('component name must be a non-empty string');
  }
  const tag = config.name;
  if (typeof tag !== 'string' || tag.trim() === '') {
    throw new NestedComponentError('tag name must be a non-empty string');
  }
  if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(tag)) {
    throw new NestedComponentError('tag name must be a valid HTML tag');
  }
  if (config.key !== undefined && typeof config.key !== 'string') {
    throw new NestedComponentError('key must be a string when present');
  }

  return Object.freeze({
    tag,
    component: config.component,
    ...(config.key === undefined ? {} : { key: config.key }),
  });
}

/**
 * Render a registered server component as a nested child inside a parent's
 * render output.
 *
 * `nameOrConfig` is either a plain component name (default `div` wrapper) or
 * the result of {@link defineNestedComponent} (custom tag + optional key).
 * The child is rendered through the server-components runtime bound to the
 * current request context, so it receives its own signed snapshot, CSRF
 * token, and component id. Its `authorize` is re-evaluated for this request
 * independently of the parent.
 *
 * Returns a Preact host element whose `dangerouslySetInnerHTML` carries the
 * child's trusted HTML. The returned VNode is suitable for inclusion in a
 * parent's `render` output.
 *
 * Throws a value-free {@link NestedComponentError} when:
 * - The runtime is not available on the context (e.g. a static export where
 *   `context.services` is absent, or a context without the server-components
 *   plugin).
 * - The child component is not registered.
 * - The child's `authorize` denies the request.
 *
 * ```tsx
 * // Simple: default div wrapper.
 * const childHtml = await renderNested('task-list', context);
 *
 * // Advanced: custom tag + key.
 * const config = defineNestedComponent({ name: 'section', component: 'card', key: 'main' });
 * const childHtml = await renderNested(config, context);
 * ```
 *
 * Nested state is independent — document this: each child carries its own
 * signed snapshot and re-verifies it on every update; a parent snapshot never
 * contains child state, and a valid parent token does not grant access to any
 * child.
 */
export async function renderNested(
  nameOrConfig: string | NestedComponentConfig,
  context: RequestContext,
): Promise<VNode> {
  const config = resolveConfig(nameOrConfig);

  // Resolve the runtime from the request context's service registry. The
  // runtime must already be registered by the server-components plugin;
  // static exports and contexts without services carry none.
  const services = context.services;
  if (services === undefined) {
    throw new NestedComponentError('server components are not available in this context');
  }

  let runtime;
  try {
    runtime = services.tryGet(serverComponentsToken);
  } catch {
    runtime = undefined;
  }
  if (runtime === undefined || typeof runtime.render !== 'function') {
    throw new NestedComponentError('server components runtime is not registered');
  }

  // Render the child through the runtime.
  let html: string;
  try {
    html = await renderServerComponentHtml(config.component, context);
  } catch (error) {
    if (error instanceof ServerComponentError || error instanceof ServerComponentRuntimeError) {
      throw new NestedComponentError('nested component render failed');
    }
    throw error;
  }

  // Wrap in the configured tag. The child's HTML is trusted producer content
  // (the runtime already owns its escaping and markers), so it is placed via
  // dangerouslySetInnerHTML without further sanitisation.
  const attrs: Record<string, unknown> = {};
  if (config.key !== undefined) {
    attrs['data-nested-key'] = config.key;
  }

  return h(config.tag, {
    ...attrs,
    dangerouslySetInnerHTML: { __html: html },
  });
}

/** Parse a string or config into a normalised config (defaults to `div` tag). */
function resolveConfig(nameOrConfig: string | NestedComponentConfig): NestedComponentConfig {
  if (typeof nameOrConfig === 'string') {
    return { tag: 'div', component: nameOrConfig };
  }
  if (nameOrConfig === null || typeof nameOrConfig !== 'object') {
    throw new NestedComponentError('renderNested requires a component name or nested config');
  }
  return nameOrConfig;
}
