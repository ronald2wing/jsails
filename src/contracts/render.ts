/**
 * Page and server-component contracts for the renderer, filesystem pages, and
 * static site generation.
 */

import type { RenderChild } from './component.js';
import type { JsonObject, RequestContext } from './http.js';
import type { RouteManifestEntry } from '../routing/manifest.js';

export { SERVER_ONLY } from './component.js';
export type {
  Component,
  ComponentChildren,
  FunctionComponent,
  IntrinsicElement,
  RenderChild,
  VNode,
} from './component.js';

/** Props passed to a page's default export. */
export type PageProps = Record<string, unknown>;

/**
 * The default export of a page: renders props to a render child.
 *
 * May be async: the framework resolves the promise through its async renderer
 * (`renderToStringAsync`). Preact function components stay synchronous; async
 * data should be loaded in {@link PageModule.load} and passed in as props.
 */
export interface PageComponent<P = PageProps> {
  (props: P, context?: RequestContext): RenderChild | Promise<RenderChild>;
}

/**
 * A filesystem-routed page module.
 *
 * `default` renders the page; `context` is omitted during static generation.
 * `load` resolves dynamic props from the request context (async data fetch).
 * `getStaticPaths` enumerates the params for static generation. Filename-to-
 * route mapping is owned elsewhere.
 */
export interface PageModule<P = PageProps> {
  default: PageComponent<P>;
  load?(context: RequestContext): P | Promise<P>;
  getStaticPaths?(): Array<Record<string, string>> | Promise<Array<Record<string, string>>>;
}

/** Options controlling a single page render, shared by every renderer. */
export interface PageRenderOptions {
  /**
   * Reject a default component annotated `SERVER_ONLY` instead of rendering it
   * to a static file. Nested annotations are not inspected.
   */
  staticMode?: boolean;
}

/**
 * Adapter seam for rendering one page route.
 *
 * A renderer receives the manifest entry, the request context, and render
 * options, and returns the complete HTML document as a string (or a promise of
 * one). The returned string is trusted producer output: JSails never sanitizes
 * it. The built-in Preact renderer keeps Preact's escaping; a custom renderer
 * owns the escaping and safety of everything it emits.
 */
export interface PageRenderer {
  render(
    entry: RouteManifestEntry,
    context: RequestContext,
    options?: PageRenderOptions,
  ): string | Promise<string>;
}

/** A single stateful backend action. */
export interface ServerAction<State, Input = unknown> {
  /** Validate untrusted input, returning the validated value; throw on invalid. */
  validate(input: unknown): Input | Promise<Input>;
  /**
   * Authorize the action for the request. REQUIRED and default-deny: the
   * framework treats any absent or falsy result as a denial.
   */
  authorize(context: RequestContext, state: State, input: Input): boolean | Promise<boolean>;
  /**
   * Execute the action. `state` is a request-local clone; mutate it in place.
   * Return a JSON result, or `void` when no state change is produced.
   */
  run(
    state: State,
    input: Input,
    context: RequestContext,
  ): JsonObject | void | Promise<JsonObject | void>;
}

/** A stateful, server-rendered component with backend actions. */
export interface ServerComponent<State = JsonObject, Input = unknown> {
  /** Stable machine identifier for wiring and serialization. */
  readonly id: string;
  /** Stable human-readable name. */
  readonly name: string;
  /** Produce the initial state for a request. */
  initialState(context: RequestContext): State | Promise<State>;
  /** Render the current state to a render child. */
  render(state: State, context: RequestContext): RenderChild | Promise<RenderChild>;
  /** Named actions; each implements validate/authorize/run. */
  readonly actions: Record<string, ServerAction<State, Input>>;
}

/** Render transport: serialized HTML plus optional serialized state. */
export interface Snapshot {
  /** Rendered HTML string. */
  readonly html: string;
  /** Serialized server state, present only for stateful renders. */
  readonly snapshot?: JsonObject;
}
