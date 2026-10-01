/**
 * Admin resource descriptors: the `Resource`/`ResourceDefinition` types and
 * `defineResource`.
 *
 * `defineResource(spec)` validates a resource specification — a slug, a label,
 * the list-table columns, the form fields, the optional header/row/bulk
 * actions, and the trusted `list`/`get`/`save` callbacks — and returns a deeply
 * frozen {@link Resource} descriptor. The descriptor is inert: it carries the
 * callbacks by identity plus a strict Zod object schema derived from the
 * fields, and is only consumed by {@link adminPlugin}, which mounts the actual
 * HTTP surface.
 *
 * Column validation lives in `columns.ts`, field validation in `fields.ts`, and
 * the schema derivation in `field-schemas.ts`. The module performs no I/O.
 */

import { z } from 'zod';

import type { Session } from '../../contracts/http.js';
import type { AdminAction } from '../actions.js';
import type { Disk } from '../../filesystem/disk.js';
import type { RelationManager } from '../relation-manager.js';
import { ResourceError } from './error.js';
import {
  freezeColumns,
  freezeInfolist,
  validateColumns,
  validateInfolist,
  type ResourceColumn,
  type ResourceInfolist,
} from './columns.js';
import { freezeFields, validateFields, type ResourceField } from './fields.js';
import { buildSchema } from './field-schemas.js';

/** Actions a resource's `authorize` callback may gate. */
export type ResourceAction = 'list' | 'view' | 'create' | 'update';

/** Authorization context passed to a resource's `authorize` callback. */
export interface ResourceAuthorizeContext {
  readonly session: Session;
  readonly action: ResourceAction;
  /** Present for detail actions (`view`, `update`); absent otherwise. */
  readonly recordId?: string;
}

/**
 * Per-resource authorization. Optional; when absent every admin-authorized
 * request is allowed. When present it is default-deny: the request is allowed
 * only when the callback resolves to exactly `true` — a truthy non-boolean, a
 * throw, or a rejection all deny.
 */
export type ResourceAuthorize = (context: ResourceAuthorizeContext) => boolean | Promise<boolean>;

/** Context handed to a resource's `list` callback. */
export interface ResourceListContext {
  readonly session: Session;
  readonly page: number;
  readonly pageSize: number;
  /** Sort column name (a whitelisted `sortable` column), when requested. */
  readonly sort?: string;
  /** Sort direction; only meaningful alongside `sort`. */
  readonly direction?: 'asc' | 'desc';
  /** Clamped search term; only present when a column is `searchable`. */
  readonly search?: string;
  /** Whitelisted `f_<name>` select-filter values, keyed by column name. */
  readonly filters?: Readonly<Record<string, string>>;
}

/** Result of a resource's `list` callback. */
export interface ResourceListResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly total: number;
}

/** Context handed to a resource's `get` callback. */
export interface ResourceGetContext {
  readonly session: Session;
  readonly id: string;
}

/** Context handed to a resource's `save` callback. */
export interface ResourceSaveContext {
  readonly session: Session;
  /** `null` for a create, the record id for an update. */
  readonly id: string | null;
  /** Schema-validated, type-coerced field values. */
  readonly values: Record<string, unknown>;
}

/** Context handed to a resource's `resolveFileDisk` callback. */
export interface ResourceFileDiskContext {
  /** The resolved, authorized admin session. */
  readonly session: Session;
  /** The file field name being uploaded. */
  readonly fieldName: string;
}

/** Resolve the {@link Disk} that stores a file field's upload, or `null` to skip. */
export type ResourceFileDiskResolver = (
  context: ResourceFileDiskContext,
) => Disk | null | Promise<Disk | null>;

/** Header, row, and bulk actions declared on a resource. */
interface ResourceActions {
  /** Collection-level actions (run against an empty record set). */
  readonly header?: readonly AdminAction[];
  /** Per-row actions (run against a single record). */
  readonly row?: readonly AdminAction[];
  /** Bulk actions (run against the selected records). */
  readonly bulk?: readonly AdminAction[];
}

/** Specification passed to {@link defineResource}. */
export interface ResourceDefinition {
  /** URL identifier under the panel path; an identifier with no slashes. */
  readonly slug: string;
  /** Human label used in the dashboard and page headings. */
  readonly label: string;
  /** List-table columns. */
  readonly columns: readonly ResourceColumn[];
  /** Form fields. */
  readonly fields: readonly ResourceField[];
  /** Optional per-resource default-deny authorization. */
  readonly authorize?: ResourceAuthorize;
  /** Optional header/row/bulk actions. */
  readonly actions?: ResourceActions;
  /** Optional read-only detail section shown on the edit page. */
  readonly infolist?: ResourceInfolist;
  /** Optional resolver for the disk that stores `file` field uploads. */
  readonly resolveFileDisk?: ResourceFileDiskResolver;
  /** Required: produce one page of rows plus the total count. */
  readonly list: (context: ResourceListContext) => Promise<ResourceListResult>;
  /** Optional: fetch one record for the edit form. */
  readonly get?: (context: ResourceGetContext) => Promise<Record<string, unknown> | null>;
  /** Optional: persist a create (`id: null`) or update. Absent means read-only. */
  readonly save?: (context: ResourceSaveContext) => Promise<void>;
  /** Optional: relation managers for inline related CRUD. */
  readonly relationManagers?: readonly RelationManager[];
}

/** A frozen, validated resource descriptor consumed by {@link adminPlugin}. */
export interface Resource {
  readonly slug: string;
  readonly label: string;
  readonly columns: readonly ResourceColumn[];
  readonly fields: readonly ResourceField[];
  readonly authorize?: ResourceAuthorize;
  readonly actions?: ResourceActions;
  readonly infolist?: ResourceInfolist;
  readonly resolveFileDisk?: ResourceFileDiskResolver;
  readonly list: (context: ResourceListContext) => Promise<ResourceListResult>;
  readonly get?: (context: ResourceGetContext) => Promise<Record<string, unknown> | null>;
  readonly save?: (context: ResourceSaveContext) => Promise<void>;
  /** Optional: relation managers for inline related CRUD. */
  readonly relationManagers?: readonly RelationManager[];
  /** Strict Zod object schema derived from `fields` (coerced, required, unknown-rejecting). */
  readonly schema: z.ZodType<Record<string, unknown>>;
}

/** A URL path segment identifier: no slashes, whitespace, dots, or control chars. */
const SLUG_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

/**
 * Slugs that would collide with a surface mounted by an admin plugin rather
 * than a resource. `plugins` is reserved for the first-party plugin-manager
 * page, so a resource (whose CRUD routes share the panel path namespace) must
 * never claim it.
 */
const RESERVED_SLUGS = new Set(['plugins']);

/**
 * Validate a resource spec and return a deeply frozen descriptor. The derived
 * Zod schema is built from the validated fields; the descriptor object and every
 * author-supplied collection are frozen.
 */
export function defineResource(spec: ResourceDefinition): Resource {
  validateSpec(spec);
  const schema = buildSchema(spec.fields);
  const resource: Resource = {
    slug: spec.slug,
    label: spec.label,
    columns: freezeColumns(spec.columns),
    fields: freezeFields(spec.fields),
    ...(spec.authorize === undefined ? {} : { authorize: spec.authorize }),
    ...(spec.actions === undefined ? {} : { actions: freezeActions(spec.actions) }),
    ...(spec.infolist === undefined ? {} : { infolist: freezeInfolist(spec.infolist) }),
    ...(spec.resolveFileDisk === undefined ? {} : { resolveFileDisk: spec.resolveFileDisk }),
    ...(spec.relationManagers === undefined
      ? {}
      : { relationManagers: freezeRelationManagers(spec.relationManagers) }),
    list: spec.list,
    ...(spec.get === undefined ? {} : { get: spec.get }),
    ...(spec.save === undefined ? {} : { save: spec.save }),
    schema,
  };
  return Object.freeze(resource);
}

/** Validate the spec structure, throwing value-free {@link ResourceError}s. */
function validateSpec(spec: ResourceDefinition): void {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new ResourceError('defineResource requires a spec object');
  }
  validateSlug(spec.slug);
  if (typeof spec.label !== 'string' || spec.label.trim() === '') {
    throw new ResourceError('resource label must be a non-empty string');
  }
  if (typeof spec.list !== 'function') {
    throw new ResourceError('resource must define a list function');
  }
  if (spec.get !== undefined && typeof spec.get !== 'function') {
    throw new ResourceError('resource get must be a function when present');
  }
  if (spec.save !== undefined && typeof spec.save !== 'function') {
    throw new ResourceError('resource save must be a function when present');
  }
  if (spec.authorize !== undefined && typeof spec.authorize !== 'function') {
    throw new ResourceError('resource authorize must be a function when present');
  }
  if (spec.resolveFileDisk !== undefined && typeof spec.resolveFileDisk !== 'function') {
    throw new ResourceError('resource resolveFileDisk must be a function when present');
  }
  validateColumns(spec.columns);
  validateFields(spec.fields);
  if (spec.infolist !== undefined) {
    validateInfolist(spec.infolist);
  }
  if (spec.actions !== undefined) {
    validateActions(spec.actions);
  }
  if (spec.relationManagers !== undefined) {
    validateRelationManagers(spec.relationManagers);
  }
}

/** Validate the slug as a bare identifier with no slashes or reserved values. */
function validateSlug(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ResourceError('resource slug must be a string');
  }
  if (!SLUG_PATTERN.test(value)) {
    throw new ResourceError('resource slug must be an identifier with no slashes');
  }
  if (RESERVED_SLUGS.has(value)) {
    throw new ResourceError('resource slug is reserved');
  }
  return value;
}

/** Validate the actions: each kind is a non-empty array of action descriptors. */
function validateActions(actions: ResourceActions): void {
  if (actions === null || typeof actions !== 'object' || Array.isArray(actions)) {
    throw new ResourceError('resource actions must be an object');
  }
  const seenNames = new Set<string>();
  for (const kind of ['header', 'row', 'bulk'] as const) {
    const list = actions[kind];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      throw new ResourceError('resource actions entries must be arrays');
    }
    for (const action of list) {
      if (
        action === null ||
        typeof action !== 'object' ||
        typeof (action as AdminAction).name !== 'string' ||
        typeof (action as AdminAction).label !== 'string' ||
        typeof (action as AdminAction).run !== 'function'
      ) {
        throw new ResourceError('resource actions must be action descriptors');
      }
      const name = (action as AdminAction).name;
      if (seenNames.has(name)) {
        throw new ResourceError('resource action names must be unique');
      }
      seenNames.add(name);
    }
  }
}

/** Deep-freeze a defensive copy of the actions (each descriptor stays frozen). */
function freezeActions(actions: ResourceActions): ResourceActions {
  return Object.freeze({
    ...(actions.header === undefined ? {} : { header: Object.freeze([...actions.header]) }),
    ...(actions.row === undefined ? {} : { row: Object.freeze([...actions.row]) }),
    ...(actions.bulk === undefined ? {} : { bulk: Object.freeze([...actions.bulk]) }),
  });
}

/** Freeze a defensive copy of the relation managers array. */
function freezeRelationManagers(managers: readonly RelationManager[]): readonly RelationManager[] {
  return Object.freeze([...managers]);
}

/** Validate the relation managers, requiring unique names and Resource-shaped `related`. */
function validateRelationManagers(managers: readonly RelationManager[]): void {
  if (!Array.isArray(managers)) {
    throw new ResourceError('resource relationManagers must be an array');
  }
  const seen = new Set<string>();
  for (const manager of managers) {
    if (manager === null || typeof manager !== 'object') {
      throw new ResourceError('relation manager must be a RelationManager descriptor');
    }
    if (typeof manager.name !== 'string') {
      throw new ResourceError('relation manager name must be a string');
    }
    const name = manager.name;
    if (seen.has(name)) {
      throw new ResourceError('relation manager names must be unique');
    }
    seen.add(name);
    const related = manager.related;
    if (
      related === null ||
      typeof related !== 'object' ||
      typeof related.slug !== 'string' ||
      typeof related.list !== 'function'
    ) {
      throw new ResourceError('relation manager related must be a Resource descriptor');
    }
  }
}
