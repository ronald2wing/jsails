/**
 * Server-component directive marker builders for the Livewire-style directive
 * system: pure attribute-map builders that return records for spreading onto
 * Preact elements inside a component's `render`.
 *
 * Each builder validates its argument and throws a value-free
 * {@link ServerComponentRuntimeError} on invalid input. The returned attribute
 * maps use the protocol constants from `protocol.ts` — no duplicated string
 * literals.
 */

import {
  CONFIRM_ATTRIBUTE,
  IGNORE_ATTRIBUTE,
  INTERSECT_ATTRIBUTE,
  LOADING_TARGET_ATTRIBUTE,
  REF_ATTRIBUTE,
  SHOW_ATTRIBUTE,
  SORT_ATTRIBUTE,
  TEXT_ATTRIBUTE,
} from './protocol.js';
import { ServerComponentRuntimeError } from './runtime/value-errors.js';

/** Validate that a string argument is a non-empty trimmed string. */
function validateNonEmpty(arg: unknown, label: string): asserts arg is string {
  if (typeof arg !== 'string' || arg.trim() === '') {
    throw new ServerComponentRuntimeError(`invalid ${label} argument`);
  }
}

/**
 * Build a confirmation-guard attribute map. The client will show a
 * `window.confirm` dialog keyed to this message before dispatching an action.
 */
export function confirmAttrs(message: string): Record<string, string> {
  validateNonEmpty(message, 'confirm message');
  return { [CONFIRM_ATTRIBUTE]: message };
}

/**
 * Build a loading-target attribute map. The client will toggle a loading
 * indicator on the element referenced by `target` while an update is in
 * flight.
 */
export function loadingTargetAttrs(target: string): Record<string, string> {
  validateNonEmpty(target, 'loading target');
  return { [LOADING_TARGET_ATTRIBUTE]: target };
}

/**
 * Build a conditional-visibility attribute map. The client will show or hide
 * the element based on the truthiness of the named state `field`.
 */
export function showAttrs(field: string): Record<string, string> {
  validateNonEmpty(field, 'show field');
  return { [SHOW_ATTRIBUTE]: field };
}

/**
 * Build a text-replacement attribute map. The client will set the element's
 * `textContent` to the value of the named state `field`.
 */
export function textAttrs(field: string): Record<string, string> {
  validateNonEmpty(field, 'text field');
  return { [TEXT_ATTRIBUTE]: field };
}

/**
 * Build a sort-trigger attribute map. The client will dispatch a named
 * action when the element is clicked, toggling sort state.
 */
export function sortAttrs(field: string): Record<string, string> {
  validateNonEmpty(field, 'sort field');
  return { [SORT_ATTRIBUTE]: field };
}

/**
 * Build an intersection-observer attribute map. The client will call the
 * named `action` when the element enters the viewport.
 */
export function intersectAttrs(action: string): Record<string, string> {
  validateNonEmpty(action, 'intersect action');
  return { [INTERSECT_ATTRIBUTE]: action };
}

/**
 * Build a reference-key attribute map. `name` identifies the element so the
 * client can look it up by id. The value must be a non-empty string without
 * whitespace, quotes, or control characters — it names an element id.
 */
export function refAttrs(name: string): Record<string, string> {
  if (typeof name !== 'string' || name.trim() === '' || /[\s"<>]/.test(name)) {
    throw new ServerComponentRuntimeError('invalid ref name');
  }
  return { [REF_ATTRIBUTE]: name };
}

/**
 * Build an ignore attribute map. An element carrying this marker is excluded
 * from the client's DOM-diffing pass — the client skips it during morph.
 */
export function ignoreAttrs(): Record<string, string> {
  return { [IGNORE_ATTRIBUTE]: '' };
}
