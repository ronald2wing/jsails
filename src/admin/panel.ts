/**
 * Admin panel descriptor: the immutable configuration for one administration
 * surface.
 *
 * `defineAdminPanel(options)` validates the panel options (base path, title,
 * the trusted session resolver, the default-deny authorization callback, the
 * optional pages/resources, and the optional admin plugins) and returns a
 * frozen {@link AdminPanel} descriptor. The descriptor is inert: it carries
 * callbacks by identity and is only consumed by {@link adminPlugin}, which
 * mounts the actual HTTP surface.
 *
 * The base path is validated eagerly so a malformed path fails at construction
 * time rather than surfacing as a broken Hono route later: it must be an
 * absolute path (leading `/`), must not be `/` or end with `/`, must not use
 * the reserved `/_jsails` namespace, and must not contain a backslash, control
 * characters, or a doubled slash. Every failure raises a value-free
 * {@link AdminPanelError} — the invalid path is never echoed.
 *
 * The module is ORM-free: it imports only the session contract plus the page,
 * resource, and admin-plugin descriptor types (all types) and performs no I/O.
 */

import type { AuthSessionService } from '../auth/token.js';
import type { Session } from '../contracts/http.js';
import type { ServiceToken } from '../extensions/services.js';
import type { ThemeTokens } from '../theme/tokens.js';
import type { AdminPlugin } from './admin-plugin.js';
import type { Chart } from './charts.js';
import type { Notice } from './notices.js';
import type { AdminPage } from './page.js';
import type { Resource } from './resource.js';
import type { Widget } from './widgets.js';

/** Trusted session resolver for the admin auth gate. */
export type AdminPanelResolveSession = (
  request: Request,
) => Session | null | Promise<Session | null>;

/**
 * The admin document theme. `'system'` (the default) leaves the browser's own
 * color scheme in control; `'light'` and `'dark'` force a scheme by setting the
 * matching `data-theme` attribute on the document.
 */
export type AdminTheme = 'light' | 'dark' | 'system';

/** The recognized admin themes, in a stable order. */
export const ADMIN_THEMES = Object.freeze(['light', 'dark', 'system'] as const);

/**
 * Default-deny authorization for the admin surface. The request is served only
 * when the callback resolves to exactly `true`; a truthy non-boolean, a throw,
 * or a rejection all deny. It receives the resolved session, which is `null`
 * when the resolver returned nothing or failed.
 */
export type AdminPanelAuthorize = (session: Session | null) => boolean | Promise<boolean>;

/** Options for {@link defineAdminPanel}. */
export interface AdminPanelOptions {
  /** Admin base path; defaults to {@link DEFAULT_ADMIN_PATH}. */
  readonly path?: string;
  /** Admin document title; defaults to {@link DEFAULT_ADMIN_TITLE}. */
  readonly title?: string;
  /**
   * Admin document theme; defaults to {@link DEFAULT_ADMIN_THEME} (`'system'`).
   * Rendered as the document's `data-theme` attribute plus minimal light/dark
   * CSS variables; no client bundle is involved.
   */
  readonly theme?: AdminTheme;
  /**
   * Custom theme CSS / token overrides appended after the default theme CSS so
   * they win on equal specificity. Both `css` and `tokens` are optional; omit
   * the entire object to keep the default theme unchanged.
   */
  readonly themeCustomization?: AdminThemeCustomization;
  /**
   * Trusted session resolver for the auth gate. Exactly one of `resolveSession`
   * or {@link AdminPanelOptions.auth} is required.
   */
  readonly resolveSession?: AdminPanelResolveSession;
  /**
   * Auth session service to derive the session resolver from (the first-party
   * `auth` plugin's {@link authSessionToken}). Exactly one of `resolveSession`
   * or `auth` is required.
   */
  readonly auth?: ServiceToken<AuthSessionService>;
  /** Default-deny authorization; allow only on an exact `true`. */
  readonly authorize: AdminPanelAuthorize;
  /** Server-rendered page descriptors mounted under the panel path. */
  readonly pages?: readonly AdminPage[];
  /** Admin plugins whose contributions (pages/resources/navigation) are mounted. */
  readonly adminPlugins?: readonly AdminPlugin[];
  /** Resource CRUD descriptors mounted under the panel path. */
  readonly resources?: readonly Resource[];
  /** Dashboard stat-card widgets. */
  readonly widgets?: readonly Widget[];
  /** Dashboard SVG charts. */
  readonly charts?: readonly Chart[];
  /** Notice registry entries rendered from `?_notice=` query parameters. */
  readonly notices?: readonly Notice[];
}

/**
 * A map of CSS custom-property names to values, serialized into a `:root` rule.
 */
export type AdminThemeTokens = Readonly<Record<string, string>>;

/**
 * Custom theme CSS: a raw CSS string, a token map, or both (both are merged).
 * Custom rules are appended after the default theme CSS so they win on equal
 * specificity. Values are injected verbatim into a `<style>` tag, so a string
 * containing `</style` is a configuration error rather than something the
 * framework escapes — escaping would silently corrupt legitimate CSS and the
 * seam is a trusted config, so a value that can break out of the `<style>` tag
 * is rejected at construction with a value-free error.
 */
export interface AdminThemeCustomization {
  /** Raw CSS appended after the default theme CSS (custom wins on equal specificity). */
  readonly css?: string;
  /** CSS custom properties emitted as a `:root { --name: value; }` rule. */
  readonly tokens?: AdminThemeTokens;
}

/** A frozen, validated panel descriptor consumed by {@link adminPlugin}. */
export interface AdminPanel {
  /** Validated admin base path. */
  readonly path: string;
  /** Admin document title. */
  readonly title: string;
  /** Admin document theme. */
  readonly theme: AdminTheme;
  /** Custom theme CSS / token overrides. */
  readonly themeCustomization?: AdminThemeCustomization;
  /**
   * The resolved theme service (`jsails/theme`), when the `theme` plugin is
   * present. Its `toCss()` — the full `:root` active tokens plus per-named-theme
   * `[data-theme]` blocks — is emitted by the document renderer, so a plugin
   * theme (named themes, `[data-theme]` switching, seed derivation) renders in
   * the admin, not just the two hardcoded light/dark variables.
   */
  readonly themeTokens?: ThemeTokens;
  /** Trusted session resolver for the auth gate; absent when `auth` is set. */
  readonly resolveSession?: AdminPanelResolveSession;
  /** Auth session service the admin plugin resolves its session from, when set. */
  readonly auth?: ServiceToken<AuthSessionService>;
  /** Default-deny authorization; allow only on an exact `true`. */
  readonly authorize: AdminPanelAuthorize;
  /** Page descriptors, frozen when present. */
  readonly pages?: readonly AdminPage[];
  /** Admin plugin descriptors, frozen when present. */
  readonly adminPlugins?: readonly AdminPlugin[];
  /** Resource CRUD descriptors, frozen when present. */
  readonly resources?: readonly Resource[];
  /** Dashboard widgets, frozen when present. */
  readonly widgets?: readonly Widget[];
  /** Dashboard charts, frozen when present. */
  readonly charts?: readonly Chart[];
  /** Notice registry entries, frozen when present. */
  readonly notices?: readonly Notice[];
}

/** Default admin base path when `path` is omitted. */
export const DEFAULT_ADMIN_PATH = '/admin';

/** Default admin document title when `title` is omitted. */
export const DEFAULT_ADMIN_TITLE = 'Admin';

/** Default admin document theme when `theme` is omitted. */
export const DEFAULT_ADMIN_THEME: AdminTheme = 'system';

/** Raised for invalid panel options. Messages never embed input values. */
export class AdminPanelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminPanelError';
  }
}

/** Resolved, validated options internal to {@link defineAdminPanel}. */
interface ResolvedPanel {
  readonly path: string;
  readonly title: string;
  readonly theme: AdminTheme;
  readonly themeCustomization: AdminThemeCustomization | undefined;
  readonly resolveSession: AdminPanelResolveSession | undefined;
  readonly auth: ServiceToken<AuthSessionService> | undefined;
  readonly authorize: AdminPanelAuthorize;
  readonly pages: readonly AdminPage[] | undefined;
  readonly adminPlugins: readonly AdminPlugin[] | undefined;
  readonly resources: readonly Resource[] | undefined;
  readonly widgets: readonly Widget[] | undefined;
  readonly charts: readonly Chart[] | undefined;
  readonly notices: readonly Notice[] | undefined;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Validate panel options and return a frozen descriptor. The `pages`,
 * `adminPlugins`, and `resources` arrays are frozen too, so the descriptor is
 * deeply immutable once returned.
 */
export function defineAdminPanel(options: AdminPanelOptions): AdminPanel {
  const resolved = resolveOptions(options);
  const panel: AdminPanel = {
    path: resolved.path,
    title: resolved.title,
    theme: resolved.theme,
    authorize: resolved.authorize,
    ...(resolved.themeCustomization === undefined
      ? {}
      : { themeCustomization: resolved.themeCustomization }),
    ...(resolved.resolveSession === undefined ? {} : { resolveSession: resolved.resolveSession }),
    ...(resolved.auth === undefined ? {} : { auth: resolved.auth }),
    ...(resolved.pages === undefined ? {} : { pages: resolved.pages }),
    ...(resolved.adminPlugins === undefined ? {} : { adminPlugins: resolved.adminPlugins }),
    ...(resolved.resources === undefined ? {} : { resources: resolved.resources }),
    ...(resolved.widgets === undefined ? {} : { widgets: resolved.widgets }),
    ...(resolved.charts === undefined ? {} : { charts: resolved.charts }),
    ...(resolved.notices === undefined ? {} : { notices: resolved.notices }),
  };
  return Object.freeze(panel);
}

/** Validate {@link AdminPanelOptions} into {@link ResolvedPanel}. */
function resolveOptions(options: AdminPanelOptions): ResolvedPanel {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new AdminPanelError('defineAdminPanel requires an options object');
  }
  const hasResolveSession = typeof options.resolveSession === 'function';
  const hasAuth = options.auth !== undefined;
  if (hasResolveSession === hasAuth) {
    throw new AdminPanelError('admin panel requires exactly one of resolveSession or auth');
  }
  if (hasResolveSession && typeof options.resolveSession !== 'function') {
    throw new AdminPanelError('admin resolveSession must be a function');
  }
  if (hasAuth && !isServiceToken(options.auth)) {
    throw new AdminPanelError('admin auth must be a service token');
  }
  if (typeof options.authorize !== 'function') {
    throw new AdminPanelError('admin authorize must be a function');
  }
  return {
    path: options.path === undefined ? DEFAULT_ADMIN_PATH : validatePath(options.path),
    title: options.title === undefined ? DEFAULT_ADMIN_TITLE : validateTitle(options.title),
    theme: resolveTheme(options.theme),
    themeCustomization: resolveThemeCustomization(options.themeCustomization),
    resolveSession: hasResolveSession ? options.resolveSession : undefined,
    auth: hasAuth ? options.auth : undefined,
    authorize: options.authorize,
    pages: resolvePages(options.pages),
    adminPlugins: resolveAdminPlugins(options.adminPlugins),
    resources: resolveResources(options.resources),
    widgets: resolveWidgets(options.widgets),
    charts: resolveCharts(options.charts),
    notices: resolveNotices(options.notices),
  };
}

/** A service-token-shaped value: an object with a non-empty string `name`. */
function isServiceToken(value: unknown): value is ServiceToken<AuthSessionService> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const name: unknown = (value as { name?: unknown }).name;
  return typeof name === 'string' && name.trim() !== '';
}

/** Validate the base path, throwing a value-free {@link AdminPanelError}. */
function validatePath(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AdminPanelError('admin path must be a string');
  }
  if (!value.startsWith('/')) {
    throw new AdminPanelError('admin path must start with "/"');
  }
  if (value === '/') {
    throw new AdminPanelError('admin path must not be "/"');
  }
  if (value.endsWith('/')) {
    throw new AdminPanelError('admin path must not end with "/"');
  }
  if (value === '/_jsails' || value.startsWith('/_jsails/')) {
    throw new AdminPanelError('admin path must not use the reserved /_jsails namespace');
  }
  if (value.includes('\\')) {
    throw new AdminPanelError('admin path must not contain backslashes');
  }
  if (CONTROL_CHARS.test(value)) {
    throw new AdminPanelError('admin path must not contain control characters');
  }
  if (value.includes('//')) {
    throw new AdminPanelError('admin path must not contain "//"');
  }
  return value;
}

/** Validate the title, throwing a value-free {@link AdminPanelError}. */
function validateTitle(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AdminPanelError('admin title must be a non-empty string');
  }
  return value;
}

/** Validate the theme, defaulting to {@link DEFAULT_ADMIN_THEME}. */
function resolveTheme(value: unknown): AdminTheme {
  if (value === undefined) {
    return DEFAULT_ADMIN_THEME;
  }
  if (typeof value !== 'string' || !(ADMIN_THEMES as readonly string[]).includes(value)) {
    throw new AdminPanelError('admin theme must be one of light, dark, or system');
  }
  return value as AdminTheme;
}

/** Validate the `themeCustomization` option, returning a frozen object or `undefined`. */
function resolveThemeCustomization(value: unknown): AdminThemeCustomization | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AdminPanelError('admin themeCustomization must be an object');
  }
  const record = value as Record<string, unknown>;
  const css = validateCustomCss(record.css);
  const tokens = validateCustomTokens(record.tokens);
  if (css === undefined && tokens === undefined) {
    return undefined;
  }
  return Object.freeze({
    ...(css === undefined ? {} : { css }),
    ...(tokens === undefined ? {} : { tokens }),
  });
}

/** Validate the raw CSS string; `undefined` is allowed (absent). */
function validateCustomCss(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new AdminPanelError('admin themeCustomization css must be a string');
  }
  if (CONTROL_CHARS.test(value)) {
    throw new AdminPanelError('admin themeCustomization css must not contain control characters');
  }
  // Values are injected verbatim into a <style> element. Escaping would corrupt
  // legitimate CSS, and the seam is trusted config, so a string that can break
  // out of the tag is rejected as a configuration error.
  if (/<\/style/i.test(value)) {
    throw new AdminPanelError('admin themeCustomization css must not contain "</style"');
  }
  return value;
}

/** Validate the token map; `undefined` is allowed, `{}` is allowed (no rule emitted). */
function validateCustomTokens(value: unknown): AdminThemeTokens | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AdminPanelError('admin themeCustomization tokens must be an object');
  }
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record);
  if (entries.length === 0) {
    return undefined;
  }
  for (const [key, val] of entries) {
    if (!/^--[A-Za-z0-9-]+$/.test(key)) {
      throw new AdminPanelError(
        'admin themeCustomization token names must be CSS custom properties',
      );
    }
    if (typeof val !== 'string') {
      throw new AdminPanelError('admin themeCustomization token values must be strings');
    }
    if (CONTROL_CHARS.test(val)) {
      throw new AdminPanelError(
        'admin themeCustomization token values must not contain control characters',
      );
    }
    // Token values are also injected into a <style> element verbatim; the same
    // reasoning as validateCustomCss applies.
    if (/<\/style/i.test(val)) {
      throw new AdminPanelError('admin themeCustomization token values must not contain "</style"');
    }
  }
  const tokens: Record<string, string> = {};
  for (const [key, val] of entries) {
    tokens[key] = val as string;
  }
  return Object.freeze(tokens);
}

/** Validate the optional pages, requiring unique slugs and freezing a copy. */
function resolvePages(value: unknown): readonly AdminPage[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new AdminPanelError('admin pages must be an array of page descriptors');
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof (entry as AdminPage).slug !== 'string' ||
      typeof (entry as AdminPage).label !== 'string' ||
      typeof (entry as AdminPage).render !== 'function'
    ) {
      throw new AdminPanelError('admin pages must be page descriptors');
    }
    const slug = (entry as AdminPage).slug;
    if (seen.has(slug)) {
      throw new AdminPanelError('admin page slugs must be unique');
    }
    seen.add(slug);
  }
  return Object.freeze([...value]);
}

/** Validate the optional admin plugins, requiring unique ids and freezing a copy. */
function resolveAdminPlugins(value: unknown): readonly AdminPlugin[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new AdminPanelError('admin adminPlugins must be an array of admin plugin descriptors');
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof (entry as AdminPlugin).id !== 'string' ||
      typeof (entry as AdminPlugin).register !== 'function'
    ) {
      throw new AdminPanelError('admin adminPlugins must be admin plugin descriptors');
    }
    const id = (entry as AdminPlugin).id;
    if (seen.has(id)) {
      throw new AdminPanelError('admin plugin ids must be unique');
    }
    seen.add(id);
  }
  return Object.freeze([...value]);
}

/** Validate the optional resources, requiring unique slugs and freezing a copy. */
function resolveResources(value: unknown): readonly Resource[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new AdminPanelError('admin resources must be an array of resource descriptors');
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof (entry as Resource).slug !== 'string' ||
      typeof (entry as Resource).label !== 'string' ||
      typeof (entry as Resource).list !== 'function'
    ) {
      throw new AdminPanelError('admin resources must be resource descriptors');
    }
    const slug = (entry as Resource).slug;
    if (seen.has(slug)) {
      throw new AdminPanelError('admin resource slugs must be unique');
    }
    seen.add(slug);
  }
  return Object.freeze([...value]);
}

/** Validate the optional widgets, requiring unique names and freezing a copy. */
function resolveWidgets(value: unknown): readonly Widget[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new AdminPanelError('admin widgets must be an array of widget descriptors');
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof (entry as Widget).name !== 'string' ||
      typeof (entry as Widget).label !== 'string' ||
      typeof (entry as Widget).render !== 'function'
    ) {
      throw new AdminPanelError('admin widgets must be widget descriptors');
    }
    const name = (entry as Widget).name;
    if (seen.has(name)) {
      throw new AdminPanelError('admin widget names must be unique');
    }
    seen.add(name);
  }
  return Object.freeze([...value]);
}

/** Validate the optional charts, requiring unique names and freezing a copy. */
function resolveCharts(value: unknown): readonly Chart[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new AdminPanelError('admin charts must be an array of chart descriptors');
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof (entry as Chart).name !== 'string' ||
      typeof (entry as Chart).label !== 'string' ||
      typeof (entry as Chart).render !== 'function'
    ) {
      throw new AdminPanelError('admin charts must be chart descriptors');
    }
    const name = (entry as Chart).name;
    if (seen.has(name)) {
      throw new AdminPanelError('admin chart names must be unique');
    }
    seen.add(name);
  }
  return Object.freeze([...value]);
}

/** Validate the optional notices, requiring unique codes and freezing a copy. */
function resolveNotices(value: unknown): readonly Notice[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new AdminPanelError('admin notices must be an array of notice descriptors');
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof (entry as Notice).code !== 'string' ||
      typeof (entry as Notice).level !== 'string' ||
      typeof (entry as Notice).message !== 'string'
    ) {
      throw new AdminPanelError('admin notices must be notice descriptors');
    }
    const code = (entry as Notice).code;
    if (seen.has(code)) {
      throw new AdminPanelError('admin notice codes must be unique');
    }
    seen.add(code);
  }
  return Object.freeze([...value]);
}
