/**
 * DRF-inspired resource handlers: a thin HTTP layer over a store adapter plus
 * a serializer. `createResourceHandlers` produces method-keyed handlers with
 * the filesystem API worker signature `(request, context) => Response`, so a
 * Hono worker can dispatch `handlers.collection[request.method]` without
 * re-implementing validation, authorization, or pagination.
 *
 * ## Store contract and row scoping
 *
 * The store adapter is the ONLY place that knows how rows map to identities.
 * Every store method receives the `RequestContext`, so an adapter that scopes
 * rows to the caller filters in `count` and `list` (and, where relevant,
 * `get`). The handler never rewrites or augments a query; a store that returns
 * unscoped `list` results but a scoped `count` — or vice versa — produces
 * inconsistent pages, and leaking other callers' rows in `list` is the
 * adapter's bug, not something this layer can or does paper over. This module
 * deliberately does NOT infer row-level policies from the `authorize` callback
 * for list results: filtering a page after counting would desynchronize the
 * count, so list scoping is the store's responsibility, not the handler's.
 *
 * ## Authorization (default-deny, two-phase on detail)
 *
 * `authorize(context, action, resource?)` is REQUIRED and default-deny: the
 * request is allowed only when the callback resolves to exactly `true` — any
 * falsy or truthy non-boolean result, a throw, or a rejection denies.
 * Collection actions (`list`, `create`) run a single general check. Detail
 * actions run a general check first, fetch the object, then an object-level
 * check with the fetched record BEFORE the record is serialized, updated, or
 * deleted — so a denied detail request never touches `serialize`/`update`/
 * `remove`, and a denied collection request never touches the store at all.
 *
 * ## Statuses
 *
 * Handlers return 200 (list/retrieve/update), 201 (create), 204 (destroy),
 * 400 (validation, malformed/oversized JSON), 403 (authorization), 404 (missing
 * id or record), and 500 (unexpected store/serializer errors, message never
 * leaked). 405 for unsupported methods (e.g. PUT) is produced by the dispatch
 * layer that maps `request.method` onto this shape, not by these handlers.
 */

import { concatBytes } from '../internal/bytes.js';
import { ValidationError } from './validation.js';
import type { Serializer } from './serialization.js';
import { paginate } from './pagination.js';
import type { PaginationOptions } from './pagination.js';
import type { RequestContext } from '../contracts/http.js';

/** Actions a resource handler can authorize. Mirrors DRF's action names. */
export type ResourceAction = 'list' | 'create' | 'retrieve' | 'update' | 'delete';

/**
 * Authorization callback. REQUIRED and default-deny: the request is allowed
 * only when the callback returns (or resolves to) exactly `true` — any other
 * value, a throw, or a rejection denies. `resource` is present only on the
 * object-level check after a successful detail fetch.
 */
export interface Authorize<TResource = unknown> {
  (
    context: RequestContext,
    action: ResourceAction,
    resource?: TResource,
  ): boolean | Promise<boolean>;
}

/**
 * Storage adapter. No ORM assumptions: any persistence can back it. Methods
 * receive the `RequestContext` so the adapter scopes queries to the caller —
 * `count` and `list` MUST agree on the scoped set or pages will be wrong.
 * `create`/`update` receive already-validated payloads.
 */
export interface ResourceStore<TRecord = unknown, TInput = unknown, TPartial = Partial<TInput>> {
  count(context: RequestContext): Promise<number>;
  list(offset: number, limit: number, context: RequestContext): Promise<TRecord[]>;
  get(id: string, context: RequestContext): Promise<TRecord | null>;
  create(data: TInput, context: RequestContext): Promise<TRecord>;
  update(id: string, data: TPartial, context: RequestContext): Promise<TRecord | null>;
  delete(id: string, context: RequestContext): Promise<void>;
}

/** A filesystem API worker handler: takes the request and its context. */
export type ResourceHandler = (
  request: Request,
  context: RequestContext,
) => Response | Promise<Response>;

/** Collection-level handlers, keyed by HTTP method. */
export interface CollectionHandlers {
  GET: ResourceHandler;
  POST: ResourceHandler;
}

/** Detail-level handlers, keyed by HTTP method. */
export interface DetailHandlers {
  GET: ResourceHandler;
  PATCH: ResourceHandler;
  DELETE: ResourceHandler;
}

/** The complete handler set produced by {@link createResourceHandlers}. */
export interface ResourceHandlers {
  collection: CollectionHandlers;
  detail: DetailHandlers;
}

/** Options for {@link createResourceHandlers}. */
export interface ResourceHandlersOptions<TInput, TOutput, TRecord> {
  /** Whitelists write input and read output; drives validation + rendering. */
  serializer: Serializer<TInput, TOutput>;
  /** Persistence adapter; responsible for row scoping via the context. */
  store: ResourceStore<TRecord, TInput, Partial<TInput>>;
  /** Required default-deny authorization callback; only exactly `true` allows. */
  authorize: Authorize<TRecord>;
  /** Route parameter holding the record id. Defaults to `"id"`. */
  idParam?: string;
  /** Page size cap and default, forwarded to the pagination helper. */
  pagination?: PaginationOptions;
  /**
   * Upper bound on the JSON request body, in bytes. Enforced before parsing so
   * an oversized body is never fully buffered. Defaults to 64 KiB; the app-level
   * HTTP server should enforce its own (separate) limit as the primary guard.
   */
  maxJsonBytes?: number;
}

const DEFAULT_MAX_JSON_BYTES = 64 * 1024;

/** An HTTP error carrying a public, non-sensitive message. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = 'HttpError';
  }
}

/** Canonical pagination integers: plain base-10 digits only, no sign/format. */
const DIGITS = /^[0-9]+$/;

/**
 * Builds collection (`GET`/`POST`) and detail (`GET`/`PATCH`/`DELETE`)
 * handlers around a serializer, store, and authorization callback.
 */
export function createResourceHandlers<TInput, TOutput, TRecord>(
  options: ResourceHandlersOptions<TInput, TOutput, TRecord>,
): ResourceHandlers {
  const {
    serializer,
    store,
    authorize,
    idParam = 'id',
    pagination = {},
    maxJsonBytes = DEFAULT_MAX_JSON_BYTES,
  } = options;

  const collection: CollectionHandlers = {
    GET: guard(async (_request, context) => {
      await assertAuthorized(authorize, context, 'list');
      const params = parsePaginationParams(context.url);
      const page = await paginate(
        {
          count: () => store.count(context),
          list: (offset, limit) => store.list(offset, limit, context),
        },
        params,
        pagination,
      );
      return jsonResponse(
        { ...page, results: page.results.map((record) => serializer.toRepresentation(record)) },
        200,
      );
    }),

    POST: guard(async (request, context) => {
      await assertAuthorized(authorize, context, 'create');
      const body = await readJsonBody(request, maxJsonBytes);
      const input = serializer.validate(body);
      const record = await store.create(input, context);
      return jsonResponse(serializer.toRepresentation(record), 201);
    }),
  };

  const detail: DetailHandlers = {
    GET: guard(async (_request, context) => {
      await assertAuthorized(authorize, context, 'retrieve');
      const id = requireId(context, idParam);
      const record = await store.get(id, context);
      if (record === null) {
        throw new HttpError(404, 'Not found');
      }
      await assertAuthorized(authorize, context, 'retrieve', record);
      return jsonResponse(serializer.toRepresentation(record), 200);
    }),

    PATCH: guard(async (request, context) => {
      await assertAuthorized(authorize, context, 'update');
      const id = requireId(context, idParam);
      const record = await store.get(id, context);
      if (record === null) {
        throw new HttpError(404, 'Not found');
      }
      await assertAuthorized(authorize, context, 'update', record);
      const body = await readJsonBody(request, maxJsonBytes);
      const patch = serializer.validate(body, { partial: true });
      const updated = await store.update(id, patch, context);
      if (updated === null) {
        throw new HttpError(404, 'Not found');
      }
      return jsonResponse(serializer.toRepresentation(updated), 200);
    }),

    DELETE: guard(async (_request, context) => {
      await assertAuthorized(authorize, context, 'delete');
      const id = requireId(context, idParam);
      const record = await store.get(id, context);
      if (record === null) {
        throw new HttpError(404, 'Not found');
      }
      await assertAuthorized(authorize, context, 'delete', record);
      await store.delete(id, context);
      return new Response(null, { status: 204 });
    }),
  };

  return { collection, detail };
}

/** Wraps a handler so any thrown error maps to a safe HTTP response. */
function guard(
  handler: (request: Request, context: RequestContext) => Promise<Response>,
): ResourceHandler {
  return (request, context) => handler(request, context).catch(toErrorResponse);
}

/** Maps a thrown error to a response, never leaking internal messages. */
function toErrorResponse(error: unknown): Response {
  if (error instanceof ValidationError) {
    return jsonResponse(
      {
        errors: error.issues.map((issue) => ({
          path: [...issue.path],
          code: issue.code,
          message: issue.message,
        })),
      },
      400,
    );
  }
  if (error instanceof HttpError) {
    return jsonResponse({ error: error.publicMessage }, error.status);
  }
  return jsonResponse({ error: 'Internal server error' }, 500);
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function assertAuthorized<TRecord>(
  authorize: Authorize<TRecord>,
  context: RequestContext,
  action: ResourceAction,
  resource?: TRecord,
): Promise<void> {
  let allowed: unknown;
  try {
    allowed = await authorize(context, action, resource);
  } catch {
    allowed = false;
  }
  if (allowed !== true) {
    throw new HttpError(403, 'Forbidden');
  }
}

function requireId(context: RequestContext, idParam: string): string {
  const id = context.params[idParam];
  if (id === undefined) {
    throw new HttpError(404, 'Not found');
  }
  return id;
}

/**
 * Parses `page`/`pageSize` from the query string as canonical positive
 * integers: digits only (so `Number()` can never smuggle `Infinity`, exponents,
 * hex, signs, or whitespace), bounded by `Number.isSafeInteger`. Absent values
 * are omitted so the pagination helper applies its defaults.
 */
function parsePaginationParams(url: URL): { page?: number; pageSize?: number } {
  const parsed: { page?: number; pageSize?: number } = {};
  for (const key of ['page', 'pageSize'] as const) {
    const raw = url.searchParams.get(key);
    if (raw === null) {
      continue;
    }
    if (!DIGITS.test(raw)) {
      throw invalidPagination(key);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw invalidPagination(key);
    }
    parsed[key] = value;
  }
  return parsed;
}

function invalidPagination(key: 'page' | 'pageSize'): ValidationError {
  return new ValidationError([
    {
      path: [key],
      code: key === 'page' ? 'invalid_page' : 'invalid_page_size',
      message: `${key} must be a positive integer`,
    },
  ]);
}

/**
 * Reads and parses a JSON request body with a hard byte bound. A declared
 * `content-length` over the limit is rejected before the stream is read; the
 * stream is otherwise consumed via a reader so an oversized body is bounded
 * rather than buffered whole. Invalid JSON yields a generic 400.
 */
async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new HttpError(400, 'Request body too large');
    }
  }

  const body = request.body;
  if (body === null) {
    throw new HttpError(400, 'Invalid JSON');
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value !== undefined) {
        received += value.byteLength;
        if (received > maxBytes) {
          throw new HttpError(400, 'Request body too large');
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(new TextDecoder().decode(concatBytes(chunks)));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}
