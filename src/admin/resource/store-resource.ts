/**
 * Store-backed admin resource: a factory that derives a `Resource` descriptor
 * from a `ResourceStore` + `Serializer`, synthesising `list`/`get`/`save`
 * callbacks so a store-backed admin CRUD shares the same store and serializer
 * as the API side.
 *
 * ## Store call adaptation
 *
 * The admin resource callbacks receive admin-specific context types
 * (`ResourceListContext`, `ResourceGetContext`, `ResourceSaveContext`), which
 * carry a `Session` but not a full `RequestContext`. The store methods expect
 * `RequestContext`. A minimal `RequestContext` is synthesised from the session
 * so the store's row-scoping (which reads `context.session`) works correctly.
 * Stores that depend on other `RequestContext` fields (e.g. the request URL)
 * should use a hand-written resource descriptor instead.
 *
 * ## Sort and filter handling
 *
 * The standard `ResourceStore.list(offset, limit, context)` signature accepts
 * no sort or filter arguments. Sort, direction, search, and `f_<name>` filter
 * values from the admin list context are gracefully ignored (value-free, never
 * thrown) — the caller must provide those through a store extension if needed.
 */

import type { Session, RequestContext } from '../../contracts/http.js';
import type { ResourceStore } from '../../api/resource.js';
import type { Serializer } from '../../api/serialization.js';
import type { ResourceColumn } from './columns.js';
import type { ResourceField } from './fields.js';
import type { ResourceInfolist } from './columns.js';
import type { RelationManager } from '../relation-manager.js';
import type { ResourceAuthorize, ResourceFileDiskResolver } from './resource-descriptor.js';
import {
  defineResource,
  type Resource,
  type ResourceDefinition,
  type ResourceListContext,
  type ResourceListResult,
  type ResourceGetContext,
  type ResourceSaveContext,
} from './resource-descriptor.js';

/** Default admin list page size: 25 rows per page. */
const DEFAULT_PAGE_SIZE = 25;

/** Raised for an invalid store-resource spec. Messages never embed input values. */
export class StoreResourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreResourceError';
  }
}

/** Specification for {@link defineStoreResource}. */
export interface StoreResourceSpec {
  /** URL identifier under the panel path (passed through to `defineResource`). */
  readonly slug: string;
  /** Persistence adapter shared with the API side. */
  readonly store: ResourceStore<any, any, any>;
  /** Serializer that maps records to whitelisted representations. */
  readonly serializer: Serializer<any, any>;
  /** Human label; defaults to `slug` when omitted. */
  readonly label?: string;
  /** List-table columns; defaults to a single generic `id` column. */
  readonly columns?: readonly ResourceColumn[];
  /** Form fields; defaults to an empty array (read-only default). */
  readonly fields?: readonly ResourceField[];
  /** Optional per-resource authorization. */
  readonly authorize?: ResourceAuthorize;
  /** Optional header/row/bulk actions. */
  readonly actions?: ResourceDefinition['actions'];
  /** Optional read-only detail section. */
  readonly infolist?: ResourceInfolist;
  /** Optional resolver for `file` field upload disks. */
  readonly resolveFileDisk?: ResourceFileDiskResolver;
  /** Optional relation managers. */
  readonly relationManagers?: readonly RelationManager[];
}

/**
 * Build a frozen admin `Resource` whose `list`/`get`/`save` callbacks are
 * synthesised from a `ResourceStore` and `Serializer`.
 *
 * The returned descriptor delegates to {@link defineResource}, so every
 * validation and freezing rule applies.
 */
export function defineStoreResource(spec: StoreResourceSpec): Resource {
  validateSpec(spec);

  const { store, serializer } = spec;
  const label = spec.label ?? spec.slug;
  const columns: readonly ResourceColumn[] = spec.columns ?? [{ name: 'id', label: 'ID' }];
  const fields: readonly ResourceField[] = spec.fields ?? [];

  const list = async (ctx: ResourceListContext): Promise<ResourceListResult> => {
    const pageSize = ctx.pageSize > 0 ? ctx.pageSize : DEFAULT_PAGE_SIZE;
    const offset = (ctx.page - 1) * pageSize;
    const rc = synthesizeRequestContext(ctx.session);
    const [rows, total] = await Promise.all([store.list(offset, pageSize, rc), store.count(rc)]);
    return {
      rows: rows.map((r) => serializer.toRepresentation(r) as Record<string, unknown>),
      total,
    };
  };

  const get = async (ctx: ResourceGetContext): Promise<Record<string, unknown> | null> => {
    const rc = synthesizeRequestContext(ctx.session);
    const record = await store.get(ctx.id, rc);
    if (record === null) return null;
    return serializer.toRepresentation(record) as Record<string, unknown>;
  };

  const save = async (ctx: ResourceSaveContext): Promise<void> => {
    const rc = synthesizeRequestContext(ctx.session);
    if (ctx.id === null) {
      await store.create(ctx.values, rc);
    } else {
      await store.update(ctx.id, ctx.values, rc);
    }
  };

  const definition: ResourceDefinition = {
    slug: spec.slug,
    label,
    columns: [...columns],
    fields: [...fields],
    list,
    get,
    save,
    ...(spec.authorize === undefined ? {} : { authorize: spec.authorize }),
    ...(spec.actions === undefined ? {} : { actions: spec.actions }),
    ...(spec.infolist === undefined ? {} : { infolist: spec.infolist }),
    ...(spec.resolveFileDisk === undefined ? {} : { resolveFileDisk: spec.resolveFileDisk }),
    ...(spec.relationManagers === undefined ? {} : { relationManagers: spec.relationManagers }),
  };

  return defineResource(definition);
}

/** Build a minimal `RequestContext` carrying only the session. */
function synthesizeRequestContext(session: Session): RequestContext {
  return {
    request: new Request('http://localhost/'),
    url: new URL('http://localhost/'),
    params: {},
    session,
  };
}

/** Validate the store-resource spec structure. */
function validateSpec(spec: StoreResourceSpec): void {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new StoreResourceError('defineStoreResource requires a spec object');
  }
  if (typeof spec.slug !== 'string' || spec.slug.trim() === '') {
    throw new StoreResourceError('store resource slug must be a non-empty string');
  }
  if (spec.store === null || typeof spec.store !== 'object') {
    throw new StoreResourceError('store resource store must be an object');
  }
  const s = spec.store as unknown as Record<string, unknown>;
  const requiredMethods = ['count', 'list', 'get', 'create', 'update', 'delete'] as const;
  for (const method of requiredMethods) {
    if (typeof s[method] !== 'function') {
      throw new StoreResourceError(
        'store resource store must implement the ResourceStore interface',
      );
    }
  }
  if (spec.serializer === null || typeof spec.serializer !== 'object') {
    throw new StoreResourceError('store resource serializer must be an object');
  }
  if (
    typeof (spec.serializer as unknown as Record<string, unknown>).toRepresentation !== 'function'
  ) {
    throw new StoreResourceError('store resource serializer must expose toRepresentation');
  }
  if (spec.label !== undefined && (typeof spec.label !== 'string' || spec.label.trim() === '')) {
    throw new StoreResourceError('store resource label must be a non-empty string when present');
  }
}
