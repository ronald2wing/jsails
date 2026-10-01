/**
 * Admin plugin contributions: the Filament-style extension seam for composing
 * an admin panel out of pages, resources, and free-form navigation items.
 *
 * `defineAdminPlugin(spec)` validates a plugin specification — a non-empty id
 * plus a `register` callback that receives an {@link AdminPluginBuilder} — and
 * returns a frozen {@link AdminPlugin} descriptor. The descriptor is inert: it
 * is only consumed by {@link adminPlugin}, which invokes `register` during
 * application assembly so a plugin can contribute pages (`addPage`), resources
 * (`addResource`), and additional navigation links (`addNavigationItem`).
 *
 * Contributions are collected once, before routes are mounted, so every
 * plugin-provided surface shares the same dashboard navigation and the same
 * panel-wide slug uniqueness guarantee. The builder is a plain object handed to
 * trusted plugin code; a structurally invalid contribution is rejected with an
 * {@link AdminPluginError} at register time rather than surfacing as a broken
 * route later.
 *
 * The module is ORM-free: it imports only the page/resource descriptor types
 * and performs no I/O.
 */

import type { AdminPage } from './page.js';
import type { Resource } from './resource.js';

/** A free-form dashboard navigation link contributed by a plugin. */
export interface AdminNavigationItem {
  /** Human link label. */
  readonly label: string;
  /** Link target (an absolute path or full URL). */
  readonly href: string;
  /** Optional navigation group. */
  readonly group?: string;
  /** Optional navigation sort weight; lower sorts first. Defaults to `0`. */
  readonly sort?: number;
}

/** The contribution surface handed to a plugin's `register` callback. */
export interface AdminPluginBuilder {
  /** Contribute an admin page. */
  addPage(page: AdminPage): void;
  /** Contribute a free-form dashboard navigation link. */
  addNavigationItem(item: AdminNavigationItem): void;
  /** Contribute an admin CRUD resource. */
  addResource(resource: Resource): void;
}

/** A frozen, validated plugin descriptor consumed by {@link adminPlugin}. */
export interface AdminPlugin {
  /** Non-empty plugin id, unique within a panel. */
  readonly id: string;
  /** Invoked during assembly with the contribution builder. */
  readonly register: (builder: AdminPluginBuilder) => void;
}

/** Specification passed to {@link defineAdminPlugin}. */
export interface AdminPluginDefinition {
  /** Non-empty plugin id, unique within a panel. */
  readonly id: string;
  /** Invoked during assembly with the contribution builder. */
  readonly register: (builder: AdminPluginBuilder) => void;
}

/** Raised for invalid plugin specs. Messages never embed input values. */
export class AdminPluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminPluginError';
  }
}

/** Validate a plugin spec and return a frozen descriptor. */
export function defineAdminPlugin(spec: AdminPluginDefinition): AdminPlugin {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new AdminPluginError('defineAdminPlugin requires a spec object');
  }
  if (typeof spec.id !== 'string' || spec.id.trim() === '') {
    throw new AdminPluginError('admin plugin id must be a non-empty string');
  }
  if (typeof spec.register !== 'function') {
    throw new AdminPluginError('admin plugin must define a register function');
  }
  return Object.freeze({ id: spec.id, register: spec.register });
}
