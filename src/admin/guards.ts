/** Admin mutation and session guards: origin/CSRF checks plus session resolution. */

import { checkTrustedMutation } from '../internal/trusted-mutation.js';
import type { Session } from '../contracts/http.js';
import type { AdminPanel } from './panel.js';

/**
 * Resolve and authorize the admin session. Returns the session only when the
 * panel's `resolveSession` produced one and `panel.authorize` resolved to
 * exactly `true`; a null resolver result, a truthy non-boolean, a throw, or a
 * rejection all return `null`.
 */
export async function assertAdminSession(
  panel: AdminPanel,
  request: Request,
): Promise<Session | null> {
  const resolveSession = panel.resolveSession;
  // A panel built from `auth` (rather than a `resolveSession` callback) has no
  // resolver here; the admin plugin derives one during setup. Fail closed.
  if (typeof resolveSession !== 'function') {
    return null;
  }
  let session: Session | null;
  try {
    session = (await resolveSession(request)) ?? null;
  } catch {
    return null;
  }
  if (session === null) {
    return null;
  }
  try {
    if ((await panel.authorize(session)) !== true) {
      return null;
    }
  } catch {
    return null;
  }
  return session;
}

/**
 * Parse a urlencoded/multipart request body into string fields only. A body
 * that cannot be parsed (or carries non-string values) yields an empty map; the
 * dangerous `__proto__`/`constructor`/`prototype` keys are always dropped.
 */
export async function readFormBody(request: Request): Promise<Record<string, string>> {
  return (await readFormBodyAndFiles(request)).values;
}

/** A file part from a parsed multipart body (structure only, no global File type). */
export interface UploadedFilePart {
  /** The uploaded file's basename. */
  readonly name: string;
  /** The uploaded file's MIME type (may be empty). */
  readonly type: string;
  /** Read the file's bytes. */
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** A parsed form body: the string fields plus any uploaded file parts. */
export interface ParsedFormBody {
  /** String-only field values, dangerous keys dropped. */
  readonly values: Record<string, string>;
  /** File parts keyed by field name; non-file values are never included. */
  readonly files: ReadonlyMap<string, UploadedFilePart>;
}

/**
 * Parse a urlencoded/multipart request body into string fields and file parts.
 * A body that cannot be parsed yields empty results; the dangerous
 * `__proto__`/`constructor`/`prototype` keys are always dropped.
 */
export async function readFormBodyAndFiles(request: Request): Promise<ParsedFormBody> {
  const contentType = request.headers.get('content-type') ?? '';

  let entries: IterableIterator<[string, unknown]>;
  try {
    if (contentType.toLowerCase().includes('multipart/form-data')) {
      const formData = await request.formData();
      entries = formData.entries();
    } else {
      entries = new URLSearchParams(await request.text()).entries();
    }
  } catch {
    return { values: {}, files: new Map() };
  }

  const values: Record<string, string> = {};
  const files = new Map<string, UploadedFilePart>();
  for (const [key, value] of entries) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }
    if (typeof value === 'string') {
      values[key] = value;
    } else if (isFilePart(value)) {
      files.set(key, value);
    }
  }
  return { values, files };
}

/** Detect a File-like value by its `arrayBuffer` method (never `instanceof File`). */
function isFilePart(value: unknown): value is UploadedFilePart {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === 'function'
  );
}

/**
 * Enforce the panel's mutation guards: a same-origin `Origin` header and a
 * submitted `_csrf` field matching the session token (constant-time). Returns
 * `true` only when both hold.
 */
export function assertAdminMutation(
  request: Request,
  session: Session,
  body: Record<string, string>,
): boolean {
  return checkTrustedMutation(request, session, { csrfValue: body['_csrf'] }).allowed;
}
