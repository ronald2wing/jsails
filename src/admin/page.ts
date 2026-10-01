/**
 * Admin pages: declarative, server-rendered page descriptors for the admin
 * panel.
 *
 * `defineAdminPage(spec)` validates a page specification — a slug, a label, an
 * optional grouping/badge/sort for the dashboard navigation, a synchronous or
 * asynchronous `render` callback that returns the page HTML, and an optional
 * `handlePost` callback for same-origin, CSRF-checked mutations — and returns a
 * frozen {@link AdminPage} descriptor. The descriptor is inert: it carries the
 * callbacks by identity and is only consumed by {@link adminPlugin}, which
 * mounts the actual HTTP surface.
 *
 * A page's `render` receives an {@link AdminPageRenderContext} (the resolved
 * admin session, the panel base path, the raw request, and its URL) and returns
 * the full document HTML — or a promise of it. The page owns its own escaping;
 * the core never sanitizes the returned string. `handlePost`, when present,
 * receives the same context plus the parsed string-only form body; the core has
 * already enforced a same-origin `Origin` and a matching `_csrf` token before
 * calling it, so a page's `handlePost` only implements its own policy. A page
 * without `handlePost` rejects `POST` with a 405.
 *
 * The module is ORM-free: it imports only the session contract (a type) and
 * performs no I/O.
 */

import type { Session } from '../contracts/http.js';
import type { ThemeTokens } from '../theme/tokens.js';
import type { AdminTheme, AdminThemeCustomization } from './panel.js';

/** Context handed to a page's `render` callback for a `GET` request. */
export interface AdminPageRenderContext {
  /** The resolved, authorized admin session. */
  readonly session: Session;
  /** The panel base path (e.g. `/admin`). */
  readonly path: string;
  /** The raw incoming request. */
  readonly request: Request;
  /** The parsed request URL. */
  readonly url: URL;
  /** The panel's admin theme, for rendering a themed document. */
  readonly theme?: AdminTheme;
  /** Custom theme CSS / token overrides the panel was configured with. */
  readonly themeCustomization?: AdminThemeCustomization;
  /** The resolved `jsails/theme` service, for a fuller themed document. */
  readonly themeTokens?: ThemeTokens;
}

/** Context handed to a page's `handlePost` callback for a `POST` request. */
export interface AdminPagePostContext extends AdminPageRenderContext {
  /** The parsed string-only form body (the `_csrf` field is still present). */
  readonly body: Record<string, string>;
}

/** A frozen, validated page descriptor consumed by {@link adminPlugin}. */
export interface AdminPage {
  /** URL identifier under the panel path; an identifier with no slashes. */
  readonly slug: string;
  /** Human label used in the dashboard navigation and page heading. */
  readonly label: string;
  /** Optional dashboard navigation group. */
  readonly group?: string;
  /** Optional short badge rendered next to the navigation label. */
  readonly badge?: string;
  /** Optional navigation sort weight; lower sorts first. Defaults to `0`. */
  readonly sort?: number;
  /** Required: render the full document HTML for a `GET`. */
  readonly render: (context: AdminPageRenderContext) => string | Promise<string>;
  /** Optional: handle a same-origin, CSRF-checked `POST`. */
  readonly handlePost?: (context: AdminPagePostContext) => Response | Promise<Response>;
}

/** Specification passed to {@link defineAdminPage}. */
export interface AdminPageDefinition {
  /** URL identifier under the panel path. */
  readonly slug: string;
  /** Human navigation/page label. */
  readonly label: string;
  /** Optional navigation group. */
  readonly group?: string;
  /** Optional badge. */
  readonly badge?: string;
  /** Optional navigation sort weight. */
  readonly sort?: number;
  /** Render the full document HTML for a `GET`. */
  readonly render: (context: AdminPageRenderContext) => string | Promise<string>;
  /** Handle a same-origin, CSRF-checked `POST`. */
  readonly handlePost?: (context: AdminPagePostContext) => Response | Promise<Response>;
}

/** Raised for invalid page specs. Messages never embed input values. */
export class AdminPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminPageError';
  }
}

/** A URL path segment identifier: no slashes, whitespace, dots, or control chars. */
const SLUG_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

/**
 * Validate a page spec and return a frozen descriptor. The callbacks are
 * carried by identity; every other field is copied onto a frozen object.
 */
export function defineAdminPage(spec: AdminPageDefinition): AdminPage {
  validateSpec(spec);
  const page: AdminPage = {
    slug: spec.slug,
    label: spec.label,
    ...(spec.group === undefined ? {} : { group: spec.group }),
    ...(spec.badge === undefined ? {} : { badge: spec.badge }),
    ...(spec.sort === undefined ? {} : { sort: spec.sort }),
    render: spec.render,
    ...(spec.handlePost === undefined ? {} : { handlePost: spec.handlePost }),
  };
  return Object.freeze(page);
}

/** Validate the spec structure, throwing value-free {@link AdminPageError}s. */
function validateSpec(spec: AdminPageDefinition): void {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new AdminPageError('defineAdminPage requires a spec object');
  }
  validateSlug(spec.slug);
  if (typeof spec.label !== 'string' || spec.label.trim() === '') {
    throw new AdminPageError('admin page label must be a non-empty string');
  }
  if (typeof spec.render !== 'function') {
    throw new AdminPageError('admin page must define a render function');
  }
  if (spec.handlePost !== undefined && typeof spec.handlePost !== 'function') {
    throw new AdminPageError('admin page handlePost must be a function when present');
  }
  if (spec.group !== undefined && (typeof spec.group !== 'string' || spec.group.trim() === '')) {
    throw new AdminPageError('admin page group must be a non-empty string when present');
  }
  if (spec.badge !== undefined && typeof spec.badge !== 'string') {
    throw new AdminPageError('admin page badge must be a string when present');
  }
  if (spec.sort !== undefined && typeof spec.sort !== 'number') {
    throw new AdminPageError('admin page sort must be a number when present');
  }
}

/** Validate the slug as a bare identifier with no slashes. */
function validateSlug(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AdminPageError('admin page slug must be a string');
  }
  if (!SLUG_PATTERN.test(value)) {
    throw new AdminPageError('admin page slug must be an identifier with no slashes');
  }
  return value;
}
