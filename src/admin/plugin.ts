/**
 * Admin plugin: turns a frozen {@link AdminPanel} descriptor into a first-party
 * {@link JsailsPlugin} named `admin`.
 *
 * This module is the assembly seam: `adminPlugin(panel)` returns the plugin via
 * `definePlugin`; its `setup` resolves the concrete session resolver, collects
 * every contribution — the panel's own `pages`, `resources`, `widgets`, and
 * `notices` plus anything each `adminPlugins` entry registers through its
 * builder — then wires the trusted HTTP hook that mounts, under `panel.path`,
 * the dashboard, the global search page, each page's routes, each resource's
 * CRUD and action routes, and the catch-all 404. Route registration itself
 * lives in `routes.ts` (panel/page mounting + gates), `resource-routes.ts`
 * (CRUD), and `action-routes.ts` (confirm-then-run actions); the whitelisted
 * list-query parsing lives in `list-query.ts`.
 *
 * The plugin is ORM-free and never touches the filesystem or network until a
 * request reaches a route that needs it.
 */

import { definePlugin, type JsailsPlugin } from '../extensions/plugin-contract.js';
import type { ServiceRegistrar } from '../extensions/services.js';
import type { ThemeTokens } from '../theme/tokens.js';
import { themeToken } from '../theme/plugin.js';
import { AdminPanelError, type AdminPanel } from './panel.js';
import type { AdminNavigationItem, AdminPluginBuilder } from './admin-plugin.js';
import type { AdminPage } from './page.js';
import type { Resource } from './resource.js';
import { registerResourceRoutes } from './resource-routes.js';
import { registerAdminNotFound, registerAdminRoutes, type Contributions } from './routes.js';

/**
 * Build the `admin` plugin from a frozen panel descriptor. The panel is
 * captured by reference; contribution collection and route registration are
 * deferred to `setup` so nothing is mounted until the application assembles
 * the extension's HTTP hooks.
 *
 * When the panel is built from `auth` (rather than a `resolveSession` callback)
 * the plugin declares `requires: [panel.auth]`, so the `auth` plugin must be
 * declared earlier — the extension runner fails with a value-free error
 * otherwise. `setup` then derives the concrete resolver from the auth service
 * and routes the resolved panel, so every route reads `panel.resolveSession`
 * unchanged.
 */
export function adminPlugin(panel: AdminPanel): JsailsPlugin {
  return definePlugin({
    name: 'admin',
    requires: panel.auth === undefined ? [] : [panel.auth],
    setup({ services, configureHttp }) {
      const resolvedPanel = resolvePanel(panel, services);
      const contributions = collectContributions(resolvedPanel);
      configureHttp((app) => {
        registerAdminRoutes(app, resolvedPanel, contributions);
        for (const resource of contributions.resources) {
          registerResourceRoutes(app, resolvedPanel, resource);
        }
        registerAdminNotFound(app, resolvedPanel);
      });
    },
  });
}

/**
 * Derive a concrete session resolver when the panel was built from `auth`,
 * and merge any theme-token service contributions into the panel's
 * `themeCustomization`. The panel's own tokens always win (app-wins-highest);
 * service-level tokens fill gaps the panel did not set.
 *
 * A panel built with a `resolveSession` callback is returned unchanged; a
 * panel built with `auth` resolves the service from the registry (guaranteed by
 * `requires`) and wraps its `resolveSession`. A panel with neither cannot occur
 * (`defineAdminPanel` enforces exactly one) but fails closed anyway.
 */
function resolvePanel(panel: AdminPanel, services: ServiceRegistrar): AdminPanel {
  let resolved = panel;

  if (panel.resolveSession === undefined) {
    const auth = panel.auth;
    if (auth === undefined) {
      throw new AdminPanelError('admin panel is missing both resolveSession and auth');
    }
    const service = services.get(auth);
    resolved = {
      ...resolved,
      resolveSession: (request) => service.resolveSession(request),
    };
  }

  // Attach the resolved theme service (optional — absent → the document
  // renderer falls back to the hardcoded light/dark base). The full
  // `themeTokens.toCss()` (active `:root` + per-named-theme `[data-theme]`
  // blocks + seed derivation) is emitted by the document renderer, while
  // `themeCustomization.css`/`tokens` remain the app's own raw overrides.
  const themeService: ThemeTokens | undefined = services.tryGet(themeToken);
  if (themeService !== undefined) {
    resolved = { ...resolved, themeTokens: themeService };
  }

  return resolved;
}

/** Collect panel + plugin contributions and enforce slug uniqueness. */
function collectContributions(panel: AdminPanel): Contributions {
  const pages: AdminPage[] = [...(panel.pages ?? [])];
  const resources: Resource[] = [...(panel.resources ?? [])];
  const navItems: AdminNavigationItem[] = [];

  for (const plugin of panel.adminPlugins ?? []) {
    const builder: AdminPluginBuilder = {
      addPage(page) {
        assertPage(page);
        pages.push(page);
      },
      addNavigationItem(item) {
        assertNavigationItem(item);
        navItems.push(item);
      },
      addResource(resource) {
        assertResource(resource);
        resources.push(resource);
      },
    };
    plugin.register(builder);
  }

  assertUniqueSlugs(pages, resources);
  return { pages, resources, navItems };
}

/** Reject a structurally invalid page contribution with a value-free error. */
function assertPage(page: AdminPage): void {
  if (
    page === null ||
    typeof page !== 'object' ||
    typeof page.slug !== 'string' ||
    typeof page.label !== 'string' ||
    typeof page.render !== 'function'
  ) {
    throw new AdminPanelError('admin page contributions must be page descriptors');
  }
}

/** Reject a structurally invalid navigation item contribution. */
function assertNavigationItem(item: AdminNavigationItem): void {
  if (
    item === null ||
    typeof item !== 'object' ||
    typeof item.label !== 'string' ||
    typeof item.href !== 'string'
  ) {
    throw new AdminPanelError('admin navigation contributions must be navigation items');
  }
}

/** Reject a structurally invalid resource contribution with a value-free error. */
function assertResource(resource: Resource): void {
  if (
    resource === null ||
    typeof resource !== 'object' ||
    typeof resource.slug !== 'string' ||
    typeof resource.label !== 'string' ||
    typeof resource.list !== 'function'
  ) {
    throw new AdminPanelError('admin resource contributions must be resource descriptors');
  }
}

/** Reject a slug shared by a page and a resource (they mount under one path). */
function assertUniqueSlugs(pages: readonly AdminPage[], resources: readonly Resource[]): void {
  const seen = new Set<string>();
  for (const page of pages) {
    if (seen.has(page.slug)) {
      throw new AdminPanelError('admin page and resource slugs must be unique');
    }
    seen.add(page.slug);
  }
  for (const resource of resources) {
    if (seen.has(resource.slug)) {
      throw new AdminPanelError('admin page and resource slugs must be unique');
    }
    seen.add(resource.slug);
  }
}
