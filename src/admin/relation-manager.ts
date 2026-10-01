/**
 * Admin relation managers: declarative descriptors for inline CRUD of
 * related resources shown alongside a parent record.
 *
 * `defineRelationManager(spec)` validates a relation manager specification — a
 * name, a label, the related {@link Resource} descriptor, a foreign key, a
 * `list` callback, and optional `create`/`delete` callbacks — and returns a
 * frozen {@link RelationManager} descriptor. The descriptor is inert: it
 * carries callbacks by identity and is only consumed by the admin panel routes.
 *
 * `renderRelationManager(manager, rows, parentId, options)` renders a
 * server-side `<table>` from the related resource's columns plus optional
 * create/delete forms with real CSRF-gated POST routes. Every cell value is
 * rendered through {@link renderFormattedValue} so Preact owns all escaping.
 * Routes are mounted by {@link registerRelationManagerRoutes} (see
 * `relation-routes.ts`).
 *
 * The module is ORM-free: it imports only the session contract (a type) and
 * performs no I/O.
 */

import { h, type ComponentChild } from 'preact';

import { renderToString } from '../jsx/render-to-string.js';
import type { Session } from '../contracts/http.js';

import type { Resource, ResourceListResult } from './resource/resource-descriptor.js';
import type { ResourceColumn } from './resource/columns.js';

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** Raised for invalid relation manager specs. Messages never embed input values. */
export class RelationManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelationManagerError';
  }
}

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

/** Context handed to a relation manager's `list` callback. */
export interface RelationManagerListContext {
  /** The resolved, authorized admin session. */
  readonly session: Session;
  /** The parent record's own record id (stringified from `recordId`). */
  readonly parentId: string;
  /** The current page (1-based). */
  readonly page: number;
  /** The number of rows per page. */
  readonly pageSize: number;
}

/** Context handed to a relation manager's `create` callback. */
export interface RelationManagerCreateContext {
  /** The resolved, authorized admin session. */
  readonly session: Session;
  /** The parent record's own record id. */
  readonly parentId: string;
  /** Schema-validated, type-coerced field values. */
  readonly values: Record<string, unknown>;
}

/** Context handed to a relation manager's `delete` callback. */
export interface RelationManagerDeleteContext {
  /** The resolved, authorized admin session. */
  readonly session: Session;
  /** The parent record's own record id. */
  readonly parentId: string;
  /** The related record's id to delete. */
  readonly relatedId: string;
}

// ---------------------------------------------------------------------------
// Descriptor types
// ---------------------------------------------------------------------------

/** Specification passed to {@link defineRelationManager}. */
export interface RelationManagerDefinition {
  /** Unique name within the parent resource's relation managers. */
  readonly name: string;
  /** Human label used as the table heading. */
  readonly label: string;
  /** The related resource descriptor (its columns drive the table markup). */
  readonly related: Resource;
  /** The foreign key column on the related table pointing back to the parent. */
  readonly foreignKey: string;
  /** Required: produce one page of related rows plus the total count. */
  readonly list: (context: RelationManagerListContext) => Promise<ResourceListResult>;
  /** Optional: create a new related record scoped to the parent. */
  readonly create?: (context: RelationManagerCreateContext) => Promise<void>;
  /** Optional: delete one related record. */
  readonly delete?: (context: RelationManagerDeleteContext) => Promise<void>;
}

/** A frozen, validated relation manager descriptor. */
export interface RelationManager {
  readonly name: string;
  readonly label: string;
  readonly related: Resource;
  readonly foreignKey: string;
  readonly list: (context: RelationManagerListContext) => Promise<ResourceListResult>;
  readonly create?: (context: RelationManagerCreateContext) => Promise<void>;
  readonly delete?: (context: RelationManagerDeleteContext) => Promise<void>;
}

// ---------------------------------------------------------------------------
// defineRelationManager
// ---------------------------------------------------------------------------

/** A URL path segment identifier: no slashes, whitespace, dots, or control chars. */
const SLUG_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

/**
 * Validate a relation manager spec and return a frozen descriptor. The
 * callbacks are carried by identity; every other field is copied onto a
 * frozen object.
 */
export function defineRelationManager(spec: RelationManagerDefinition): RelationManager {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new RelationManagerError('defineRelationManager requires a spec object');
  }
  if (typeof spec.name !== 'string' || !SLUG_PATTERN.test(spec.name)) {
    throw new RelationManagerError('relation manager name must be an identifier with no slashes');
  }
  if (typeof spec.label !== 'string' || spec.label.trim() === '') {
    throw new RelationManagerError('relation manager label must be a non-empty string');
  }
  if (typeof spec.foreignKey !== 'string' || spec.foreignKey.trim() === '') {
    throw new RelationManagerError('relation manager foreignKey must be a non-empty string');
  }
  const related = spec.related;
  if (related === null || typeof related !== 'object' || Array.isArray(related)) {
    throw new RelationManagerError('relation manager related must be a Resource descriptor');
  }
  if (typeof related.slug !== 'string' || typeof related.list !== 'function') {
    throw new RelationManagerError('relation manager related must be a Resource descriptor');
  }
  if (typeof spec.list !== 'function') {
    throw new RelationManagerError('relation manager must define a list function');
  }
  if (spec.create !== undefined && typeof spec.create !== 'function') {
    throw new RelationManagerError('relation manager create must be a function when present');
  }
  if (spec.delete !== undefined && typeof spec.delete !== 'function') {
    throw new RelationManagerError('relation manager delete must be a function when present');
  }
  return Object.freeze({
    name: spec.name,
    label: spec.label,
    related: spec.related,
    foreignKey: spec.foreignKey,
    list: spec.list,
    ...(spec.create === undefined ? {} : { create: spec.create }),
    ...(spec.delete === undefined ? {} : { delete: spec.delete }),
  });
}

// ---------------------------------------------------------------------------
// renderRelationManager
// ---------------------------------------------------------------------------

/** Options for rendering a relation manager's forms with real routes. */
export interface RenderRelationManagerOptions {
  readonly panelPath: string;
  readonly resourceSlug: string;
  readonly csrfToken: string;
}

/**
 * Render a server-side table of related rows from the manager's related
 * resource columns, plus optional create/delete forms with real POST actions
 * and CSRF protection. Every cell value is rendered as a Preact text child so
 * escaping is owned by Preact.
 */
export function renderRelationManager(
  manager: RelationManager,
  rows: readonly Record<string, unknown>[],
  parentId: string,
  options: RenderRelationManagerOptions,
): string {
  const { related } = manager;

  const headerCells: ComponentChild[] = related.columns.map((column) =>
    h('th', null, column.label),
  );
  if (manager.delete !== undefined) {
    headerCells.push(h('th', null, ''));
  }

  const bodyRows: ComponentChild[] = rows.map((row) => {
    const id = String(row['id'] ?? '');
    const cells: ComponentChild[] = related.columns.map((column) =>
      h('td', null, renderCellValue(column, row)),
    );
    if (manager.delete !== undefined) {
      cells.push(h('td', null, renderDeleteForm(manager, parentId, id, options)));
    }
    return h('tr', null, ...cells);
  });

  const children: ComponentChild[] = [
    h('h3', null, manager.label),
    h(
      'table',
      null,
      h('thead', null, h('tr', null, ...headerCells)),
      h('tbody', null, ...bodyRows),
    ),
  ];

  if (manager.create !== undefined) {
    children.push(renderCreateForm(manager, parentId, options));
  }

  return renderToString(h('div', { class: 'admin-relation-manager' }, ...children));
}

/** Render one cell value as escaped text. */
function renderCellValue(column: ResourceColumn, row: Record<string, unknown>): ComponentChild {
  const value = row[column.name];
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

/** Render a create form for adding a new related record. */
function renderCreateForm(
  manager: RelationManager,
  parentId: string,
  options: RenderRelationManagerOptions,
): ComponentChild {
  const action = `${options.panelPath}/${options.resourceSlug}/${manager.name}`;
  return h(
    'form',
    {
      method: 'post',
      action,
      class: 'admin-relation-create',
    },
    h('input', { type: 'hidden', name: '_csrf', value: options.csrfToken }),
    h('input', { type: 'hidden', name: '_parent', value: parentId }),
    h('button', { type: 'submit' }, `New ${manager.related.label}`),
  );
}

/** Render a delete button wrapped in a form for one related row. */
function renderDeleteForm(
  manager: RelationManager,
  parentId: string,
  relatedId: string,
  options: RenderRelationManagerOptions,
): ComponentChild {
  const action = `${options.panelPath}/${options.resourceSlug}/${manager.name}/${relatedId}/delete`;
  return h(
    'form',
    {
      method: 'post',
      action,
      class: 'admin-relation-delete',
    },
    h('input', { type: 'hidden', name: '_csrf', value: options.csrfToken }),
    h('input', { type: 'hidden', name: '_parent', value: parentId }),
    h('button', { type: 'submit' }, 'Delete'),
  );
}
