/** Admin document rendering: theme-aware HTML document output with shared CSS. */

import { h, type ComponentChild } from 'preact';

import { renderToString } from '../jsx/render-to-string.js';
import type { ThemeTokens } from '../theme/tokens.js';
import type { AdminTheme, AdminThemeCustomization } from './panel.js';

/**
 * Minimal light/dark theme CSS. The `--jsails-*` variables carry the scheme:
 * `:root` defaults to light, `[data-theme="dark"]` forces dark, and a
 * `prefers-color-scheme` media query honors the OS when no explicit scheme is
 * forced (`system`). There is no client bundle.
 */
const ADMIN_THEME_CSS = [
  ':root { --jsails-bg: #ffffff; --jsails-fg: #1b1b1b; }',
  '[data-theme="light"] { --jsails-bg: #ffffff; --jsails-fg: #1b1b1b; }',
  '[data-theme="dark"] { --jsails-bg: #1b1b1b; --jsails-fg: #e6e6e6; }',
  '@media (prefers-color-scheme: dark) { :root { --jsails-bg: #1b1b1b; --jsails-fg: #e6e6e6; } }',
  'body { margin: 0; font-family: system-ui, sans-serif; background: var(--jsails-bg); color: var(--jsails-fg); }',
].join('\n');

/**
 * Options for rendering a themed admin document. When both `themeCustomization`
 * and `theme` are omitted, the output is byte-identical to the current default.
 */
export interface AdminDocumentOptions {
  readonly title: string;
  readonly theme?: AdminTheme;
  readonly themeCustomization?: AdminThemeCustomization;
  /** The resolved `jsails/theme` service, emitting its full `toCss()`. */
  readonly themeTokens?: ThemeTokens;
}

/**
 * Render a full HTML document with the given title, theme, body nodes, and
 * optional theme customization. The document shell is theme-aware but carries no
 * client bundle. The resolved theme service's full `toCss()` (active `:root`
 * tokens plus per-named-theme `[data-theme]` blocks) is emitted when present;
 * otherwise the hardcoded light/dark base plus `themeCustomization` apply.
 */
export function renderAdminDocumentWithTheme(
  options: AdminDocumentOptions,
  ...body: ComponentChild[]
): string {
  const css = buildThemeCss(options);
  return renderToString(
    h(
      'html',
      { ...(options.theme === undefined ? {} : { 'data-theme': options.theme }) },
      h('head', null, h('title', null, options.title), h('style', null, css)),
      h('body', null, ...body),
    ),
  );
}

/**
 * Render a full HTML document with the given title and body nodes, optionally
 * applying the admin theme.
 */
export function renderAdminDocument(
  title: string,
  theme?: AdminTheme,
  ...body: ComponentChild[]
): string {
  return renderAdminDocumentWithTheme({ title, theme }, ...body);
}

/** Merge the default theme CSS with the resolved theme service and any raw overrides. */
function buildThemeCss(options: AdminDocumentOptions): string {
  const parts = [ADMIN_THEME_CSS];
  // The resolved theme system (active `:root` + `[data-theme]` blocks) lands
  // after the hardcoded light/dark base so plugin tokens populate the real
  // variables; the base only supplies the two fallback light/dark vars when no
  // theme plugin exists.
  if (options.themeTokens !== undefined) {
    const themeCss = options.themeTokens.toCss();
    if (themeCss !== '') {
      parts.push(themeCss);
    }
  }
  const custom = options.themeCustomization;
  if (custom?.css !== undefined && custom.css !== '') {
    parts.push(custom.css);
  }
  if (custom?.tokens !== undefined) {
    const tokenRule = serializeThemeTokens(custom.tokens);
    if (tokenRule !== '') {
      parts.push(tokenRule);
    }
  }
  return parts.join('\n');
}

/** Serialize a token map into a single `:root { ... }` CSS rule. */
function serializeThemeTokens(tokens: import('./panel.js').AdminThemeTokens): string {
  const declarations = Object.entries(tokens).map(([name, value]) => `${name}: ${value};`);
  if (declarations.length === 0) {
    return '';
  }
  return `:root { ${declarations.join(' ')} }`;
}

/** Wrap rendered HTML in a `no-store` `text/html` response. */
export function adminHtmlResponse(html: string, status = 200): Response {
  return new Response(`<!DOCTYPE html>\n${html}`, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/** A `303 See Other` redirect (the default for a successful mutation). */
export function adminRedirectResponse(location: string, status = 303): Response {
  return new Response(null, { status, headers: { location } });
}
