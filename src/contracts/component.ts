/**
 * Preact-backed component contracts.
 *
 * JSails owns no virtual DOM of its own: `VNode` and `ComponentChildren` are
 * re-exported from Preact, and `jsxImportSource: "jsails"` resolves to a thin
 * re-export of Preact's automatic JSX runtime (`src/jsx/jsx-runtime.ts`).
 * Nothing in this module implements a renderer.
 */

import type { ComponentChildren, FunctionComponent } from 'preact';

export type { ComponentChildren, FunctionComponent, VNode } from 'preact';

/**
 * Marks a function component as server-only.
 *
 * A JSails-specific annotation carried on the component function itself.
 * Preact's renderer does not read or enforce it: nothing here rejects a
 * marked component. Enforcement belongs to the static exporter, which must
 * reject unregistered server components at build time.
 */
export const SERVER_ONLY: unique symbol = Symbol('jsails.serverOnly');

/**
 * A function component: Preact's `FunctionComponent` extended with the
 * optional JSails `SERVER_ONLY` annotation.
 *
 * Function components render synchronously. Async data belongs in a page
 * module's `load` (`contracts/render.ts`) and is passed in as props, never
 * returned as a Promise from a component.
 */
export interface Component<P = Record<string, unknown>> extends FunctionComponent<P> {
  [SERVER_ONLY]?: true;
}

/** An intrinsic HTML element tag name (e.g. "div", "span", "h1"). */
export type IntrinsicElement = string;

/** Anything a component may render: a Preact `ComponentChildren` value. */
export type RenderChild = ComponentChildren;
