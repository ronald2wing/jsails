/**
 * Bound-control value semantics for the component binding layer.
 *
 * Owns the native-control value read/write/compare helpers and the two passes
 * that move values between the DOM and a component controller's working state:
 * `captureBoundValues` (DOM → controller, skipping a file control whose
 * selection is uploaded separately) and `reapplyWorkingValues` (controller →
 * DOM, leaving an unchanged control untouched so the browser keeps its caret).
 *
 * The structural DOM contract (`ComponentElement`) lives in
 * `./controller.js` and is imported type-only, so this module stays
 * free of a DOM lib and Node-importable, matching the `islands.ts` convention.
 */

import type { JsonValue } from '../../contracts/http.js';
import { MODEL_ATTRIBUTE } from '../../server-components/protocol.js';
import type { ComponentElement } from './controller.js';
import type { ComponentController } from '../state-decoding.js';

/** Selector for a model-bound control. */
export const MODEL_SELECTOR = `[${MODEL_ATTRIBUTE}]`;

/** The slice of a live binding the capture/reapply passes touch. */
interface ControlBindingView {
  readonly element: ComponentElement;
  readonly controller: ComponentController;
}

/** Resolve the component root that owns `element`, or `null` when out of scope. */
export type ResolveOwner = (element: ComponentElement) => ComponentElement | null;

/**
 * Read a native control's value as a JSON value: a checkbox/radio yields its
 * `checked` boolean, a multi-select yields an array of selected values, a
 * numeric input yields a number when finite, and everything else yields its
 * string value.
 */
export function readControlValue(element: ComponentElement): JsonValue {
  const type = (element.type ?? '').toLowerCase();
  if (type === 'checkbox' || type === 'radio') {
    return element.checked === true;
  }
  if (element.tagName.toLowerCase() === 'select' && element.multiple === true) {
    const selected = element.selectedOptions;
    if (selected === undefined) {
      return [];
    }
    return Array.from(selected, (option) => option.value);
  }
  const raw = element.value ?? '';
  if (type === 'number' || type === 'range') {
    if (raw.trim() === '') {
      return '';
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  return raw;
}

/** True when an element is a native `input[type=file]` control. */
export function isFileInput(element: ComponentElement): boolean {
  return element.tagName.toLowerCase() === 'input' && (element.type ?? '').toLowerCase() === 'file';
}

/** Write a JSON value back onto a native control. */
function writeControlValue(element: ComponentElement, value: JsonValue): void {
  const type = (element.type ?? '').toLowerCase();
  if (type === 'checkbox' || type === 'radio') {
    element.checked = value === true;
    return;
  }
  if (element.tagName.toLowerCase() === 'select' && element.multiple === true) {
    const wanted = new Set(Array.isArray(value) ? value.map((entry) => String(entry)) : []);
    const options = element.querySelectorAll('option');
    for (const option of Array.from(options)) {
      const optionValue = option.getAttribute('value') ?? option.value ?? '';
      option.setAttribute('selected', wanted.has(optionValue) ? '' : 'false');
    }
    return;
  }
  element.value = value === null || value === undefined ? '' : String(value);
}

/** True when a control's current DOM value already equals `value`. */
function controlMatches(element: ComponentElement, value: JsonValue): boolean {
  const current = readControlValue(element);
  if (Array.isArray(current) && Array.isArray(value)) {
    if (current.length !== value.length) {
      return false;
    }
    return current.every((entry, index) => entry === value[index]);
  }
  return current === value;
}

/**
 * Collect the latest bound field values from the DOM into the controller. A
 * control owned by a nested island or component root is skipped (its owner
 * captures it), as is a file control, whose selection is uploaded separately
 * and whose reference already lives in working state.
 */
export function captureBoundValues(
  binding: ControlBindingView,
  resolveOwner: ResolveOwner,
  report: (error: unknown, element: ComponentElement) => void,
): void {
  const controls = binding.element.querySelectorAll(MODEL_SELECTOR);
  for (const control of Array.from(controls)) {
    // A control owned by a nested island or a nested component root belongs
    // to that owner, never to this binding; resolve ownership the same way
    // delegated events do so capture and dispatch agree.
    if (resolveOwner(control) !== binding.element) {
      continue;
    }
    // A file control's value is never serializable state: its selection is
    // uploaded separately and its reference already lives in working state,
    // so a capture here would clobber that reference with a raw path string.
    if (isFileInput(control)) {
      continue;
    }
    const name = control.getAttribute(MODEL_ATTRIBUTE);
    if (name === null || name === '') {
      continue;
    }
    try {
      binding.controller.setField(name, readControlValue(control));
    } catch (error) {
      report(error, control);
    }
  }
}

/**
 * Reapply working values to controls, leaving unchanged controls untouched so
 * the browser keeps their caret/selection. A file control is never written:
 * its selection is uploaded separately, so writing a reference object into
 * `value` would corrupt it.
 */
export function reapplyWorkingValues(
  binding: ControlBindingView,
  resolveOwner: ResolveOwner,
): void {
  const state = binding.controller.state;
  const controls = binding.element.querySelectorAll(MODEL_SELECTOR);
  for (const control of Array.from(controls)) {
    // Never write this component's working values onto a control owned by a
    // nested island or a nested component root.
    if (resolveOwner(control) !== binding.element) {
      continue;
    }
    // A file control cannot represent a working value: its selection is
    // uploaded separately, so writing a reference object into `value` would
    // corrupt it with a stringified object.
    if (isFileInput(control)) {
      continue;
    }
    const name = control.getAttribute(MODEL_ATTRIBUTE);
    if (name === null || !Object.hasOwn(state, name)) {
      continue;
    }
    const value = state[name] as JsonValue;
    // Skip an unchanged control so the browser keeps its caret/selection.
    if (controlMatches(control, value)) {
      continue;
    }
    writeControlValue(control, value);
  }
}
