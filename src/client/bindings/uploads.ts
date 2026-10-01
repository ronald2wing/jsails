/**
 * File-upload glue for the component binding layer.
 *
 * Owns the `type=file` bound-input path: the fixed failure message, the
 * in-flight (`data-jsails-uploading`) marker, the size-hint check, the error
 * element next to a failed input, and the change handler that drives a
 * controller's XHR upload and reflects its success/failure on the input. The
 * actual XHR transport, progress events, and reference serialization live in
 * the controller (`../state-decoding.js`); this module only glues the DOM
 * marker/error surface to it.
 */

import {
  COMPONENT_UPLOAD_MAX_BYTES_ATTRIBUTE,
  COMPONENT_UPLOADING_ATTRIBUTE,
  MODEL_ATTRIBUTE,
} from '../../server-components/protocol.js';
import {
  ComponentBindingError,
  type ComponentDocument,
  type ComponentElement,
} from './controller.js';
import type { ComponentController, ComponentUploadFile } from '../state-decoding.js';
import { MODEL_SELECTOR, isFileInput } from './control-values.js';

/** Fixed plaintext shown next to a file input whose upload failed. */
export const COMPONENT_UPLOAD_FAILED_MESSAGE = 'This file could not be uploaded. Please try again.';

/** The slice of a live binding the upload path touches. */
interface UploadBindingView {
  readonly element: ComponentElement;
  readonly controller: ComponentController;
  /** Upload error elements keyed by the file input they belong to. */
  readonly uploadErrors: WeakMap<ComponentElement, ComponentElement>;
  disposed: boolean;
}

/** First selected file of a file input, or `undefined` when none. */
function firstFile(input: ComponentElement): ComponentUploadFile | undefined {
  const files = input.files;
  if (files === undefined || files.length === 0) {
    return undefined;
  }
  return files[0];
}

/** Read the optional upload size hint from the root; `null` when absent/invalid. */
function readMaxBytesHint(binding: UploadBindingView): number | null {
  const raw = binding.element.getAttribute(COMPONENT_UPLOAD_MAX_BYTES_ATTRIBUTE);
  if (raw === null || raw === '') {
    return null;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Set or clear the in-flight upload marker on a file input. */
function setUploading(input: ComponentElement, uploading: boolean): void {
  if (uploading) {
    input.setAttribute(COMPONENT_UPLOADING_ATTRIBUTE, 'true');
  } else {
    input.removeAttribute(COMPONENT_UPLOADING_ATTRIBUTE);
  }
}

/** Clear a file input's selection so the user can retry the pick. */
function clearInputFiles(input: ComponentElement): void {
  input.value = '';
}

/** Resolve the bound file input for a field name (for progress bridging). */
export function findUploadInput(
  binding: UploadBindingView,
  field: string,
): ComponentElement | null {
  for (const element of Array.from(binding.element.querySelectorAll(MODEL_SELECTOR))) {
    if (isFileInput(element) && element.getAttribute(MODEL_ATTRIBUTE) === field) {
      return element;
    }
  }
  return null;
}

/** Render the fixed upload-failure message next to a file input (idempotent). */
function showUploadError(
  binding: UploadBindingView,
  input: ComponentElement,
  doc: ComponentDocument,
): void {
  if (binding.uploadErrors.has(input)) {
    return;
  }
  const errorElement = doc.createElement('span');
  errorElement.textContent = COMPONENT_UPLOAD_FAILED_MESSAGE;
  input.insertAdjacentElement('afterend', errorElement);
  binding.uploadErrors.set(input, errorElement);
  input.setAttribute('aria-invalid', 'true');
}

/** Remove a previously rendered upload-failure message, if present. */
function clearUploadError(binding: UploadBindingView, input: ComponentElement): void {
  const errorElement = binding.uploadErrors.get(input);
  if (errorElement !== undefined) {
    errorElement.remove();
    binding.uploadErrors.delete(input);
  }
  input.removeAttribute('aria-invalid');
}

/**
 * Handle a file selection: upload the chosen file and store its reference.
 * Upload failures are non-fatal — a fixed message is shown and the input is
 * cleared, but the controller stays usable for the next attempt.
 */
export function handleFileChange(
  binding: UploadBindingView,
  input: ComponentElement,
  name: string,
  doc: ComponentDocument,
  report: (error: unknown, element: ComponentElement) => void,
): void {
  const file = firstFile(input);
  if (file === undefined) {
    // The picker was cancelled: drop any stale error from a prior attempt.
    clearUploadError(binding, input);
    return;
  }

  const maxBytes = readMaxBytesHint(binding);
  if (maxBytes !== null && file.size > maxBytes) {
    showUploadError(binding, input, doc);
    clearInputFiles(input);
    report(new ComponentBindingError('file exceeds the maximum upload size'), input);
    return;
  }

  setUploading(input, true);
  clearUploadError(binding, input);

  binding.controller.uploadField(name, file).then(
    () => {
      if (!binding.disposed) {
        setUploading(input, false);
      }
    },
    (error: unknown) => {
      if (binding.disposed) {
        return;
      }
      setUploading(input, false);
      showUploadError(binding, input, doc);
      clearInputFiles(input);
      report(error, input);
    },
  );
}
