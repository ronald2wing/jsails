/**
 * Turbo Stream message emitters — pure string builders with no DOM, no Node
 * imports, and no `@hotwired/turbo` dependency. Every function returns a
 * serialized `<turbo-stream>` string suitable for `Turbo.renderStreamMessage`
 * or as an HTTP response body with `Content-Type: text/vnd.turbo-stream.html`.
 *
 * These are **trusted producer output**: the caller owns escaping of `html`.
 * The framework never sanitizes it — the renderer trust model applies here
 * unchanged.
 */

/** Turbo's full stream action set. */
export type TurboStreamAction =
  'replace' | 'update' | 'append' | 'prepend' | 'remove' | 'before' | 'after' | 'refresh';

const VALID_ACTIONS = new Set<string>([
  'replace',
  'update',
  'append',
  'prepend',
  'remove',
  'before',
  'after',
  'refresh',
]);

/** Mirror the target-id validation from `navigation.ts:317`. */
function validateTarget(target: string): void {
  if (typeof target !== 'string' || target.trim() === '' || /[\s"<>]/.test(target)) {
    throw new TypeError('target must be a non-empty element id without whitespace or quotes');
  }
}

function validateAction(action: string): asserts action is TurboStreamAction {
  if (!VALID_ACTIONS.has(action)) {
    throw new TypeError(`unknown Turbo Stream action "${action}"`);
  }
}

/** Actions that need no `<template>` (Turbo re-renders or removes). */
function isTemplateless(action: TurboStreamAction): boolean {
  return action === 'remove' || action === 'refresh';
}

/**
 * Build a single `<turbo-stream>` message string.
 *
 * - `remove` and `refresh` emit
 *   `<turbo-stream action="..." target="..."></turbo-stream>` with no
 *   `<template>`; `html` is ignored when supplied.
 * - Every other action emits
 *   `<turbo-stream action="..." target="..."><template>${html}</template></turbo-stream>`.
 *
 * Throws a value-free `TypeError` when `target` is invalid, `action` is
 * unrecognised, or `html` is missing for an action that requires a template.
 */
export function turboStreamMessage(action: string, target: string, html?: string): string {
  validateAction(action);
  validateTarget(target);
  if (!isTemplateless(action)) {
    if (typeof html !== 'string') {
      throw new TypeError('html is required for this Turbo Stream action');
    }
    return (
      `<turbo-stream action="${action}" target="${target}">` +
      `<template>${html}</template></turbo-stream>`
    );
  }
  return `<turbo-stream action="${action}" target="${target}"></turbo-stream>`;
}

/** Convenience: replace outer markup of `target` with `html`. */
export function replaceStream(target: string, html: string): string {
  return turboStreamMessage('replace', target, html);
}

/** Convenience: replace children of `target` with `html`. */
export function updateStream(target: string, html: string): string {
  return turboStreamMessage('update', target, html);
}

/** Convenience: append `html` as the last child of `target`. */
export function appendStream(target: string, html: string): string {
  return turboStreamMessage('append', target, html);
}

/** Convenience: prepend `html` as the first child of `target`. */
export function prependStream(target: string, html: string): string {
  return turboStreamMessage('prepend', target, html);
}

/** Convenience: remove `target` from the DOM. */
export function removeStream(target: string): string {
  return turboStreamMessage('remove', target);
}

/** Convenience: insert `html` before `target`. */
export function beforeStream(target: string, html: string): string {
  return turboStreamMessage('before', target, html);
}

/** Convenience: insert `html` after `target`. */
export function afterStream(target: string, html: string): string {
  return turboStreamMessage('after', target, html);
}

/** Convenience: re-render `target` from the original template. */
export function refreshStream(target: string): string {
  return turboStreamMessage('refresh', target);
}
