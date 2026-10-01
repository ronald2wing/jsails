/**
 * Value-free error and response builders for the server-component runtime.
 *
 * Every message here is a stable, hardcoded string: none interpolates a
 * submitted value, a token, state, or a session, so a client can never learn
 * anything about the verified snapshot or the request by triggering an error.
 * The Zod-issue mapping reduces a schema error to field-level messages without
 * echoing the raw input that produced it.
 */

import type { ZodIssue } from 'zod';

import type {
  ComponentUpdateErrorCode,
  ComponentUpdateResponse,
  ComponentUploadErrorCode,
  ComponentUploadResponse,
} from '../protocol.js';
import type { UploadError, UploadErrorCode } from '../uploads.js';

/** Raised for render-time failures (denied, unknown, missing fallback, closed). Value-free. */
export class ServerComponentRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerComponentRuntimeError';
  }
}

/** The HTTP-facing result of an update: a status plus a serializable body. */
export interface ServerComponentUpdateResult {
  readonly status: number;
  readonly body: ComponentUpdateResponse;
}

/** The HTTP-facing result of an upload: a status plus a serializable body. */
export interface ServerComponentUploadResult {
  readonly status: number;
  readonly body: ComponentUploadResponse;
}

// ---------------------------------------------------------------------------
// Zod issue mapping (value-free, stable messages; never echoes raw input)
// ---------------------------------------------------------------------------

function valueAtPath(input: unknown, path: readonly PropertyKey[]): unknown {
  let value = input;
  for (const segment of path) {
    if (value === null || value === undefined || typeof value !== 'object') {
      return undefined;
    }
    value = (value as Record<PropertyKey, unknown>)[segment];
  }
  return value;
}

function typeMessage(expected: string): string {
  switch (expected) {
    case 'string':
      return 'Expected a string';
    case 'number':
      return 'Expected a number';
    case 'int':
    case 'integer':
    case 'safeint':
      return 'Expected an integer';
    case 'boolean':
      return 'Expected a boolean';
    case 'object':
    case 'record':
      return 'Expected an object';
    case 'array':
    case 'tuple':
      return 'Expected an array';
    default:
      return 'Expected a valid value';
  }
}

function boundMessage(origin: string, bound: number | bigint, isMax: boolean): string {
  const qualifier = isMax ? 'at most' : 'at least';
  switch (origin) {
    case 'string':
      return `Must be ${qualifier} ${bound} characters`;
    case 'number':
    case 'int':
    case 'integer':
    case 'safeint':
    case 'bigint':
      return `Must be ${qualifier} ${bound}`;
    case 'array':
    case 'set':
      return `Must have ${qualifier} ${bound} items`;
    default:
      return 'Invalid value';
  }
}

function describeZodIssue(issue: ZodIssue, input: unknown): string {
  switch (issue.code) {
    case 'invalid_type': {
      const received = valueAtPath(input, issue.path);
      if (received === undefined) {
        return 'This field is required';
      }
      if (received === null) {
        return 'Value must not be null';
      }
      return typeMessage(issue.expected);
    }
    case 'too_small':
      return boundMessage(issue.origin, issue.minimum, false);
    case 'too_big':
      return boundMessage(issue.origin, issue.maximum, true);
    case 'unrecognized_keys':
      return 'Unknown field';
    default:
      return 'Invalid value';
  }
}

export function zodIssuesToFieldErrors(
  issues: readonly ZodIssue[],
  input: unknown,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const path = [...issue.path, key].map(String).join('.');
        errors[path] = 'Unknown field';
      }
      continue;
    }
    const path = issue.path.map(String).join('.');
    errors[path === '' ? 'form' : path] = describeZodIssue(issue, input);
  }
  return errors;
}

/** Build a non-validation error response with a stable code and value-free message. */
export function errorResult(
  sequence: number,
  code: ComponentUpdateErrorCode,
  message: string,
): ServerComponentUpdateResult {
  return { status: statusFor(code), body: { sequence, error: { code, message } } };
}

/** Map an error code to its HTTP status. */
function statusFor(code: ComponentUpdateErrorCode): number {
  switch (code) {
    case 'invalid_request':
      return 400;
    case 'origin_mismatch':
    case 'invalid_snapshot':
    case 'csrf_mismatch':
    case 'forbidden':
      return 403;
    case 'unknown_component':
      return 404;
    case 'internal_error':
      return 500;
  }
}

/** Build an upload error response with a stable code and value-free message. */
export function uploadErrorResult(
  code: ComponentUploadErrorCode,
  message: string,
): ServerComponentUploadResult {
  return { status: uploadStatusFor(code), body: { error: { code, message } } };
}

/** Map an upload error code to its HTTP status. */
function uploadStatusFor(code: ComponentUploadErrorCode): number {
  switch (code) {
    case 'invalid_request':
      return 400;
    case 'origin_mismatch':
    case 'invalid_snapshot':
    case 'csrf_mismatch':
    case 'forbidden':
      return 403;
    case 'unknown_component':
      return 404;
    case 'oversize':
      return 413;
    case 'unsupported_content_type':
      return 415;
    case 'storage_unavailable':
      return 503;
    case 'internal_error':
      return 500;
  }
}

/** Translate a store/signer {@link UploadError} into an HTTP upload result. */
export function uploadErrorFromStoreError(error: UploadError): ServerComponentUploadResult {
  const mapping: Record<UploadErrorCode, ComponentUploadErrorCode> = {
    invalid_reference: 'invalid_request',
    oversize: 'oversize',
    unsupported_content_type: 'unsupported_content_type',
    not_found: 'internal_error',
    invalid_input: 'invalid_request',
    io_error: 'storage_unavailable',
    storage_unavailable: 'storage_unavailable',
  };
  return uploadErrorResult(mapping[error.code], error.message);
}
