/**
 * Admin resource routes: the CRUD HTTP surface for a resource descriptor.
 *
 * `registerResourceRoutes(app, panel, resource)` mounts, under the resource
 * root (`<path>/<slug>`):
 *
 * - `GET <slug>` — the sortable, filterable, searchable, paginated list table;
 * - `GET <slug>/new`, `POST <slug>` — the empty create form and the create;
 * - `GET <slug>/:id`, `POST <slug>/:id` — the populated edit form and update.
 *
 * It also delegates the confirm-then-run action routes to
 * `registerActionRoutes` (see `action-routes.ts`). The handlers themselves are
 * split by surface: the list table (`resource-routes/list.ts`), the create/edit
 * forms (`resource-routes/form.ts`), and the create/update POST handlers
 * (`resource-routes/crud.ts`). This module only wires the routes in registration
 * order — `new` is registered before `:id` so the create form wins the `/new`
 * path.
 */

import type { Hono } from 'hono';

import { registerActionRoutes } from './action-routes.js';
import type { AdminPanel } from './panel.js';
import { registerRelationManagerRoutes } from './relation-routes.js';
import type { Resource } from './resource.js';
import { handleCreate, handleUpdate } from './resource-routes/crud.js';
import { handleCreateForm, handleEditForm } from './resource-routes/form.js';
import { handleList } from './resource-routes/list.js';

/** Register the list/new/create/edit/update routes, action routes, and relation manager routes. */
export function registerResourceRoutes(app: Hono, panel: AdminPanel, resource: Resource): void {
  const root = `${panel.path}/${resource.slug}`;
  app.get(root, (c) => handleList(panel, resource, c));
  // `new` is registered before `:id` so the create form wins the `/new` path.
  app.get(`${root}/new`, (c) => handleCreateForm(panel, resource, c));
  app.post(root, (c) => handleCreate(panel, resource, c));
  // Relation manager routes (also before `:id` so a manager name does not
  // get captured as a record id).
  for (const manager of resource.relationManagers ?? []) {
    registerRelationManagerRoutes(app, panel, resource, manager);
  }
  app.get(`${root}/:id`, (c) => handleEditForm(panel, resource, c));
  app.post(`${root}/:id`, (c) => handleUpdate(panel, resource, c));
  // Header/bulk action routes (collection-level) and row action routes.
  registerActionRoutes(app, panel, resource);
}
