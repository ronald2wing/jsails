/**
 * Thin server-rendering wrapper over Preact's render-to-string.
 *
 * JSails owns no HTML escaping/sanitizing logic and no virtual DOM: traversal
 * and escaping are Preact's. `renderToString` is synchronous and renders a
 * fully-resolved tree. Async data belongs in a page module's `load`
 * (`contracts/render.ts`) and is passed in as props before rendering; Preact
 * function components render synchronously and must not return a Promise.
 */

import { renderToString as preactRenderToString } from 'preact-render-to-string';
import type { VNode } from 'preact';

/** Synchronously render a resolved Preact VNode tree to an HTML string. */
export function renderToString<P = {}>(vnode: VNode<P>, context?: unknown): string {
  return preactRenderToString(vnode, context);
}
