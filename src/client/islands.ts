/**
 * Browser island runtime: registration and hydration of Preact "island"
 * components over server-rendered markup.
 *
 * An island is a server-rendered element carrying three markers:
 *
 * - `data-jsails-island="name"`   — the registered component name
 * - `data-jsails-props="json"`    — the serialized props (bounded JSON)
 * - `data-hydrated="true"`        — legacy readiness signal, set on hydrate,
 *   removed when the island is restored to its SSR markup
 *
 * The element `id` is optional in general but REQUIRED for a permanent island
 * (`data-turbo-permanent`), because Turbo Drive preserves a permanent element
 * by matching its `id` between the old and the new document.
 *
 * Hydration is tracked per DOM element object (a `WeakMap`), never by the
 * `data-hydrated` attribute alone: a cache restore or a Turbo clone can carry
 * the attribute without a live Preact root behind it. The `WeakMap` is not
 * iterable, so a `Set` of the same elements backs the unmount/cleanup passes;
 * entries leave both collections when a root unmounts or its element leaves the
 * document, keeping the strong `Set` bounded by live islands.
 *
 * This module is browser-safe and Node-import safe: it imports Preact only
 * (which never touches the DOM at module scope) and models the DOM surface it
 * needs with minimal structural types, so it compiles and imports without a
 * DOM lib — matching the `src/broadcast/client.ts` convention.
 *
 * The manager also exposes scoped `beforeMorph`/`afterMorph` hooks so a morph
 * owner (the component binding layer) can tear down and remount the islands
 * nested inside a subtree it is about to replace, reusing this single manager
 * rather than owning a second one.
 */

import { createElement, hydrate, render } from 'preact';
import type { ContainerNode, FunctionComponent } from 'preact';

// ---------------------------------------------------------------------------
// Marker attributes (the SSR/author contract)
// ---------------------------------------------------------------------------

/** Name of the registered component an island element hydrates into. */
export const ISLAND_ATTRIBUTE = 'data-jsails-island';

/** Serialized (bounded JSON) props for the island component. */
export const ISLAND_PROPS_ATTRIBUTE = 'data-jsails-props';

/** Legacy readiness marker, set on hydrate and removed on restore. */
export const ISLAND_HYDRATED_ATTRIBUTE = 'data-hydrated';

/** Turbo Drive permanent-element marker (matched by element `id`). */
export const TURBO_PERMANENT_ATTRIBUTE = 'data-turbo-permanent';

// ---------------------------------------------------------------------------
// Minimal structural DOM types
// ---------------------------------------------------------------------------

/**
 * The slice of a DOM element the island runtime touches. Declared structurally
 * (no DOM lib) so the module stays Node-importable; a real `HTMLElement`
 * satisfies every member, and Preact receives the element through its own
 * `ContainerNode` contract at the hydrate boundary.
 */
export interface JsailsElement {
  /** Stable id, required for `data-turbo-permanent` preservation. */
  readonly id: string;
  /** False once the element has been removed from the document. */
  readonly isConnected: boolean;
  /** Serializable inner markup, captured before hydrate and restored after. */
  innerHTML: string;
  /** Plain-text content; set (never HTML) for the generic frame-missing message. */
  textContent: string | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  querySelectorAll(selector: string): ArrayLike<JsailsElement>;
}

/** A DOM event as the runtime consumes it. */
export interface JsailsEvent {
  readonly type: string;
  readonly target: JsailsElement | null;
  readonly detail?: unknown;
  preventDefault(): void;
}

/**
 * The slice of `document` the runtime touches. `addEventListener`/
 * `removeEventListener` carry the Turbo event wiring; `dispatchEvent` carries
 * the `jsails:before-navigation` hook.
 */
export interface JsailsDocument {
  querySelectorAll(selector: string): ArrayLike<JsailsElement>;
  addEventListener(type: string, listener: (event: JsailsEvent) => void, options?: unknown): void;
  removeEventListener(
    type: string,
    listener: (event: JsailsEvent) => void,
    options?: unknown,
  ): void;
  dispatchEvent(event: JsailsEvent): boolean;
}

// ---------------------------------------------------------------------------
// Island registry
// ---------------------------------------------------------------------------

/** Props an island receives, decoded from its `data-jsails-props` marker. */
export type IslandProps = Record<string, unknown>;

/** A typed Preact island component. */
export type IslandComponent<P extends IslandProps = IslandProps> = FunctionComponent<P>;

/** A name -> component map accepted by `startClient({ islands })`. */
export type IslandMap = Readonly<Record<string, IslandComponent>>;

/** The live registry keyed by island name. */
export type IslandRegistry = Map<string, IslandComponent>;

/** Raised when a registration violates the name/component contract. */
export class IslandRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IslandRegistryError';
  }
}

/** Raised when `data-jsails-props` fails bounded-JSON validation. */
export class IslandPropsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IslandPropsError';
  }
}

const defaultRegistry: IslandRegistry = new Map();

function assertValidIslandName(name: string): void {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new IslandRegistryError('island name must be a non-empty string');
  }
  if (name in Object.prototype) {
    throw new IslandRegistryError('island name must not shadow an object prototype member');
  }
}

function assertValidIslandComponent(component: IslandComponent): void {
  if (typeof component !== 'function') {
    throw new IslandRegistryError('island component must be a function');
  }
}

/** Register `component` into `registry`, rejecting invalid or conflicting names. */
function registerInto(registry: IslandRegistry, name: string, component: IslandComponent): void {
  assertValidIslandName(name);
  assertValidIslandComponent(component);
  const existing = registry.get(name);
  if (existing !== undefined && existing !== component) {
    throw new IslandRegistryError(`island "${name}" is already registered`);
  }
  registry.set(name, component);
}

/**
 * Register an island component under `name`.
 *
 * The component is a typed Preact `FunctionComponent`; its props type is
 * preserved for callers, while the runtime hands it `IslandProps` decoded from
 * the marker (JSON is untyped at the boundary). Re-registering the same name
 * with the same component is a no-op; a different component under an existing
 * name is rejected.
 */
export function registerIsland<P extends IslandProps>(
  name: string,
  component: IslandComponent<P>,
): void {
  registerInto(defaultRegistry, name, component as IslandComponent);
}

/** Build a registry from the default plus an optional declarative `islands` map. */
export function createIslandRegistry(islands?: IslandMap): IslandRegistry {
  const registry: IslandRegistry = new Map(defaultRegistry);
  if (islands === undefined) {
    return registry;
  }
  const prototype = Object.getPrototypeOf(islands);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new IslandRegistryError('islands must be a plain object');
  }
  for (const [name, component] of Object.entries(islands)) {
    registerInto(registry, name, component);
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Bounded JSON props
// ---------------------------------------------------------------------------

/** Maximum length of a `data-jsails-props` string, in UTF-16 code units. */
export const MAX_PROPS_LENGTH = 65_536;

/** Maximum nesting depth of the decoded props object. */
const MAX_PROPS_DEPTH = 32;

/** Maximum total object keys across the decoded props object. */
const MAX_PROPS_KEYS = 1_000;

const FORBIDDEN_PROPS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Decode and validate an island's `data-jsails-props` value.
 *
 * Parsing uses `JSON.parse` only — never `eval`/`Function`. The input is
 * bounded by length, and the result is bounded by depth and total key count;
 * `__proto__`/`constructor`/`prototype` keys are rejected at any depth so a
 * hostile marker cannot pollute a prototype. Values are accepted as-is (a
 * string value such as `"constructor"` is fine); only keys are guarded.
 */
export function parseIslandProps(raw: string | null | undefined): IslandProps {
  if (raw === null || raw === undefined || raw === '') {
    return {};
  }
  if (typeof raw !== 'string') {
    throw new IslandPropsError('props must be a JSON string');
  }
  if (raw.length > MAX_PROPS_LENGTH) {
    throw new IslandPropsError('props exceed the maximum length');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new IslandPropsError('props must be valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new IslandPropsError('props must decode to a plain object');
  }
  validatePropsShape(parsed);
  return parsed as IslandProps;
}

function validatePropsShape(value: object): void {
  let keyCount = 0;
  const visit = (node: unknown, depth: number): void => {
    if (depth > MAX_PROPS_DEPTH) {
      throw new IslandPropsError('props exceed the maximum nesting depth');
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, depth + 1);
      }
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        keyCount += 1;
        if (keyCount > MAX_PROPS_KEYS) {
          throw new IslandPropsError('props exceed the maximum number of keys');
        }
        if (FORBIDDEN_PROPS_KEYS.has(key)) {
          throw new IslandPropsError('props contain a forbidden key');
        }
        visit((node as Record<string, unknown>)[key], depth + 1);
      }
    }
  };
  visit(value, 0);
}

// ---------------------------------------------------------------------------
// Island manager (mount / unmount / restore)
// ---------------------------------------------------------------------------

/** A hydrated root: its element and the SSR markup captured before hydrate. */
interface IslandMountRecord {
  readonly element: JsailsElement;
  readonly originalMarkup: string;
}

/** Coordinates hydration across a document, keyed by element identity. */
export interface IslandManager {
  readonly registry: IslandRegistry;
  /** Hydrate every un-hydrated island in the document. Idempotent per element. */
  mountAll(): void;
  /** Hydrate `root` (if it is an island) and every island inside it. */
  mountWithin(root: JsailsElement): void;
  /** Unmount non-permanent roots and restore their SSR markup (pre-cache). */
  unmountNonPermanent(): void;
  /** Unmount roots whose element is no longer connected (post-render cleanup). */
  collectRemoved(): void;
  /**
   * Unmount every non-permanent island inside `root` (not `root` itself) and
   * return a restore callback that re-hydrates exactly those islands. Used by a
   * morph owner to tear nested islands down before replacing a subtree and
   * remount them afterwards, without a second island manager.
   */
  beforeMorph(root: JsailsElement): () => void;
  /**
   * Unmount non-permanent islands inside `root` and re-hydrate the islands in
   * the (possibly replaced) subtree. A convenience wrapper over
   * {@link IslandManager.beforeMorph} for callers that do not need to interleave
   * their own work between teardown and remount.
   */
  afterMorph(root: JsailsElement): void;
}

export interface CreateIslandManagerOptions {
  document: JsailsDocument;
  registry: IslandRegistry;
  /** Called instead of `console.warn` when an element cannot be hydrated. */
  onError?: (error: unknown, element: JsailsElement) => void;
}

/** Create an island manager over a document and registry. */
export function createIslandManager(options: CreateIslandManagerOptions): IslandManager {
  const { document: doc, registry, onError } = options;

  // Identity-keyed hydration state: an element's hydrated-ness is a property of
  // the element object, not of its (forgeable) `data-hydrated` attribute.
  const mounted = new WeakMap<JsailsElement, IslandMountRecord>();
  // The WeakMap is not iterable; this mirrors its live keys for sweep passes.
  const mountedElements = new Set<JsailsElement>();

  function report(error: unknown, element: JsailsElement): void {
    if (onError !== undefined) {
      onError(error, element);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`jsails: skipping island hydration: ${message}`);
  }

  function isPermanentRoot(element: JsailsElement): boolean {
    return element.hasAttribute(TURBO_PERMANENT_ATTRIBUTE) && element.id.trim() !== '';
  }

  function hydrateElement(element: JsailsElement): void {
    if (mounted.has(element)) {
      return;
    }
    const name = element.getAttribute(ISLAND_ATTRIBUTE);
    if (name === null || name === '') {
      return;
    }
    const component = registry.get(name);
    if (component === undefined) {
      report(new IslandRegistryError(`unknown island "${name}"`), element);
      return;
    }
    let props: IslandProps;
    try {
      props = parseIslandProps(element.getAttribute(ISLAND_PROPS_ATTRIBUTE));
    } catch (error) {
      report(error, element);
      return;
    }

    const originalMarkup = element.innerHTML;
    try {
      hydrate(createElement(component, props), element as unknown as ContainerNode);
    } catch (error) {
      // A component render error must not break the navigation pipeline: report
      // it and skip this island, leaving the others to hydrate.
      report(error, element);
      return;
    }
    element.setAttribute(ISLAND_HYDRATED_ATTRIBUTE, 'true');
    mounted.set(element, { element, originalMarkup });
    mountedElements.add(element);
  }

  function unmountElement(element: JsailsElement): void {
    const record = mounted.get(element);
    if (record === undefined) {
      return;
    }
    // Tear down Preact's effects/cleanups, then restore the exact SSR markup so
    // a cached snapshot holds clean server HTML rather than hydrated DOM.
    render(null, element as unknown as ContainerNode);
    element.innerHTML = record.originalMarkup;
    element.removeAttribute(ISLAND_HYDRATED_ATTRIBUTE);
    mounted.delete(element);
    mountedElements.delete(element);
  }

  function mountElements(elements: ArrayLike<JsailsElement>): void {
    for (const element of Array.from(elements)) {
      hydrateElement(element);
    }
  }

  /**
   * Unmount the non-permanent islands inside `root` (never `root` itself) and
   * return a callback that re-hydrates the torn-down elements that are still
   * connected. Permanent roots are left mounted: Turbo preserves them by id
   * across a morph, so tearing them down would discard live state the morph is
   * meant to keep. A morph that replaces the subtree leaves the old elements
   * disconnected; the caller re-hydrates the new subtree with `mountWithin`.
   */
  function beforeMorph(root: JsailsElement): () => void {
    const nested = Array.from(root.querySelectorAll(`[${ISLAND_ATTRIBUTE}]`));
    const tornDown: JsailsElement[] = [];
    for (const element of nested) {
      if (mounted.has(element) && !isPermanentRoot(element)) {
        unmountElement(element);
        tornDown.push(element);
      }
    }
    return () => {
      for (const element of tornDown) {
        if (element.isConnected) {
          hydrateElement(element);
        }
      }
    };
  }

  return {
    registry,
    mountAll() {
      mountElements(doc.querySelectorAll(`[${ISLAND_ATTRIBUTE}]`));
    },
    mountWithin(root) {
      hydrateElement(root);
      mountElements(root.querySelectorAll(`[${ISLAND_ATTRIBUTE}]`));
    },
    unmountNonPermanent() {
      for (const element of Array.from(mountedElements)) {
        if (!isPermanentRoot(element)) {
          unmountElement(element);
        }
      }
    },
    collectRemoved() {
      for (const element of Array.from(mountedElements)) {
        if (!element.isConnected) {
          unmountElement(element);
        }
      }
    },
    beforeMorph,
    afterMorph(root) {
      beforeMorph(root)();
    },
  };
}
