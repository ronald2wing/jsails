/**
 * Admin resource CRUD POST handlers: create (`POST <slug>`) and update
 * (`POST <slug>/:id`).
 *
 * Both handlers run the shared default-deny auth gate, then the resource's own
 * `authorize` (`create`/`update`), enforce the same-origin/CSRF mutation guard,
 * and delegate to `runSave`. `runSave` first resolves a repeater add/remove
 * intent (re-rendering the form without saving), writes any uploaded file parts
 * through the resource's `resolveFileDisk` seam, then validates the coerced
 * values through the resource's derived Zod schema — a failure re-renders the
 * form (422) with per-field, value-free messages and repopulated values, and a
 * success saves and 303-redirects to the list, preserving the canonicalized
 * table state. A read-only resource (no `save`) rejects mutations with a 405.
 */

import type { Context } from 'hono';
import type { ZodError, ZodIssue } from 'zod';

import type { Disk } from '../../filesystem/disk.js';
import type { Session } from '../../contracts/http.js';
import { adminHtmlResponse, adminRedirectResponse } from '../document.js';
import {
  assertAdminMutation,
  assertAdminSession,
  readFormBodyAndFiles,
  type UploadedFilePart,
} from '../guards.js';
import { canonicalizeBack } from '../list-query.js';
import type { AdminPanel } from '../panel.js';
import { applyRepeaterIntent, detectRepeaterIntent, renderFormPage } from '../resource/render.js';
import { liftRepeaters } from '../resource/field-schemas.js';
import type { Resource, ResourceSaveContext } from '../resource.js';
import {
  forbiddenResponse,
  notFoundResponse,
  readOnlyResponse,
  resourceAllowed,
  serverErrorResponse,
} from '../routes.js';

/** POST <slug>: create a record. */
export async function handleCreate(
  panel: AdminPanel,
  resource: Resource,
  c: Context,
): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) {
    return forbiddenResponse();
  }
  if (!(await resourceAllowed(resource, session, 'create'))) {
    return forbiddenResponse();
  }
  const save = resource.save;
  if (save === undefined) {
    return readOnlyResponse();
  }
  const body = await readFormBodyAndFiles(c.req.raw);
  if (!assertAdminMutation(c.req.raw, session, body.values)) {
    return forbiddenResponse();
  }
  return runSave(panel, resource, save, session, null, body.values, body.files);
}

/** POST <slug>/:id: update a record. */
export async function handleUpdate(
  panel: AdminPanel,
  resource: Resource,
  c: Context,
): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) {
    return forbiddenResponse();
  }
  const id = c.req.param('id');
  if (id === undefined) {
    return notFoundResponse();
  }
  if (!(await resourceAllowed(resource, session, 'update', id))) {
    return forbiddenResponse();
  }
  const save = resource.save;
  if (save === undefined) {
    return readOnlyResponse();
  }
  // Verify the record exists (when a `get` callback is available) so an
  // unknown id is a 404 rather than a blind save. The fetched record also
  // back-fills field values (e.g. a file key) on repeater-intent re-renders.
  const get = resource.get;
  let record: Record<string, unknown> | null | undefined;
  if (get !== undefined) {
    try {
      record = await get({ session, id });
    } catch {
      return serverErrorResponse();
    }
    if (record === null) {
      return notFoundResponse();
    }
  }
  const body = await readFormBodyAndFiles(c.req.raw);
  if (!assertAdminMutation(c.req.raw, session, body.values)) {
    return forbiddenResponse();
  }
  return runSave(panel, resource, save, session, id, body.values, body.files, record);
}

/** Validate the submitted values; on success save and redirect to the list. */
async function runSave(
  panel: AdminPanel,
  resource: Resource,
  save: (context: ResourceSaveContext) => Promise<void>,
  session: Session,
  id: string | null,
  body: Record<string, string>,
  files: ReadonlyMap<string, UploadedFilePart>,
  record?: Record<string, unknown> | null,
): Promise<Response> {
  const values = valuesWithoutMarkers(body);
  const back = body['_back'];
  const formState = {
    id,
    values,
    csrf: session.csrfToken,
    action: `${panel.path}/${resource.slug}${id === null ? '' : `/${id}`}`,
    back: canonicalizeBack(back, resource),
  };

  // A repeater add/remove button submits with the other fields: apply the
  // intent to the submitted values and re-render the form (200) without saving.
  const intent = detectRepeaterIntent(resource, body);
  if (intent !== undefined) {
    return adminHtmlResponse(
      renderFormPage(panel, resource, {
        ...formState,
        ...(record == null ? {} : { record }),
        values: applyRepeaterIntent(resource, intent, values),
        errors: {},
      }),
      200,
    );
  }

  // Write any uploaded file parts through the disk seam before validation, so
  // the file field validates as a plain string key. A disk failure is a 500.
  const withFiles = await processFileUploads(resource, session, values, files);
  if (withFiles === null) {
    return serverErrorResponse();
  }

  const parsed = resource.schema.safeParse(withFiles);
  if (!parsed.success) {
    return adminHtmlResponse(
      renderFormPage(panel, resource, {
        ...formState,
        ...(record == null ? {} : { record }),
        values: withFiles,
        // Zod issues carry the lifted (nested) path; lift the flat values so
        // `valueAtPath` resolves a present-but-invalid repeater item correctly.
        errors: zodIssuesToFieldErrors(parsed.error, liftRepeaters(resource.fields, withFiles)),
      }),
      422,
    );
  }
  try {
    await save({ session, id, values: parsed.data });
  } catch {
    return serverErrorResponse();
  }
  const query = canonicalizeBack(back, resource);
  return adminRedirectResponse(`${panel.path}/${resource.slug}${query === '' ? '' : `?${query}`}`);
}

// ---------------------------------------------------------------------------
// Form-body helpers
// ---------------------------------------------------------------------------

/**
 * Drop the internal `_csrf`/`_back`/`_repeater_add`/`_repeater_remove` markers
 * so only field values reach validation.
 */
function valuesWithoutMarkers(body: Record<string, string>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (
      key !== '_csrf' &&
      key !== '_back' &&
      key !== '_repeater_add' &&
      key !== '_repeater_remove'
    ) {
      values[key] = value;
    }
  }
  return values;
}

// ---------------------------------------------------------------------------
// File upload
// ---------------------------------------------------------------------------

/**
 * Write uploaded file parts for every `file` field through the resource's
 * `resolveFileDisk` seam, replacing each part with the persisted key. A field
 * with no resolved disk falls back to the uploaded basename (a reference, not a
 * store). Returns `null` when a disk write fails.
 */
async function processFileUploads(
  resource: Resource,
  session: Session,
  values: Record<string, string>,
  files: ReadonlyMap<string, UploadedFilePart>,
): Promise<Record<string, string> | null> {
  const fileFields = resource.fields.filter((field) => field.type === 'file');
  if (fileFields.length === 0) {
    return values;
  }
  const result: Record<string, string> = { ...values };
  for (const field of fileFields) {
    const file = files.get(field.name);
    if (file === undefined) {
      continue;
    }
    const disk = await resolveFileDisk(resource, session, field.name);
    if (disk === null) {
      // No disk wired: persist the sanitized basename as a reference, not a store.
      result[field.name] = sanitizeSegment(file.name) || 'file';
      continue;
    }
    try {
      const key = diskKeyForUpload(field.name, file.name);
      const bytes = new Uint8Array(await file.arrayBuffer());
      await disk.put(key, bytes, file.type === '' ? undefined : { contentType: file.type });
      result[field.name] = key;
    } catch {
      return null;
    }
  }
  return result;
}

/** Resolve the disk for a `file` field; a missing/throwing resolver yields `null`. */
async function resolveFileDisk(
  resource: Resource,
  session: Session,
  fieldName: string,
): Promise<Disk | null> {
  const resolver = resource.resolveFileDisk;
  if (resolver === undefined) {
    return null;
  }
  try {
    return (await resolver({ session, fieldName })) ?? null;
  } catch {
    return null;
  }
}

/** Build a disk key of the form `<field>/<sanitized-basename>`. */
function diskKeyForUpload(fieldName: string, filename: string): string {
  const dir = sanitizeSegment(fieldName) || 'upload';
  const name = sanitizeSegment(filename) || 'file';
  return `${dir}/${name}`;
}

/**
 * Reduce a path segment to a safe, portable filename fragment: keep only the
 * final basename, strip control characters and path separators, map any other
 * unsafe character to `_`, and trim leading/trailing dots.
 */
function sanitizeSegment(value: string): string {
  const basename = value.split(/[\\/]/).pop() ?? '';
  return basename
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
}

// ---------------------------------------------------------------------------
// Zod issue mapping (value-free; never echoes raw input)
// ---------------------------------------------------------------------------

/** Map a Zod error to per-field messages, keyed by dotted path. */
function zodIssuesToFieldErrors(error: ZodError, input: unknown): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const path = [...issue.path, key].map(String).join('.');
        errors[path] = 'Unknown field';
      }
      continue;
    }
    const path = issue.path.map(String).join('.');
    if (path === '') {
      continue;
    }
    if (!(path in errors)) {
      errors[path] = describeIssue(issue, input);
    }
  }
  return errors;
}

/** Produce a stable, value-free message for one Zod issue. */
function describeIssue(issue: ZodIssue, input: unknown): string {
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
    case 'invalid_value': {
      const received = valueAtPath(input, issue.path);
      return received === undefined ? 'This field is required' : 'Invalid value';
    }
    case 'too_small':
      return boundMessage(issue.origin, issue.minimum, false);
    case 'too_big':
      return boundMessage(issue.origin, issue.maximum, true);
    default:
      return 'Invalid value';
  }
}

function typeMessage(expected: string): string {
  switch (expected) {
    case 'string':
      return 'Expected a string';
    case 'number':
    case 'int':
    case 'integer':
      return 'Expected a number';
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
      return `Must be ${qualifier} ${bound}`;
    case 'array':
    case 'set':
      return `Must have ${qualifier} ${bound} items`;
    default:
      return 'Invalid value';
  }
}

/** Walk `input` to the value at `path`, without ever copying it into text. */
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
