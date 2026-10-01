/** Admin document rendering: theme-aware HTML document output with shared CSS. */

import { h, type ComponentChild } from 'preact';

import { renderToString } from '../jsx/render-to-string.js';
import type { ThemeTokens } from '../theme/tokens.js';
import type { AdminTheme, AdminThemeCustomization } from './panel.js';

/**
 * The admin design system: a self-contained light/dark stylesheet built on the
 * `jsails/theme` core tokens (`--jsails-bg`, `--jsails-fg`, `--jsails-accent`,
 * `--jsails-muted`, `--jsails-border`) plus a handful of derived surface,
 * radius, spacing, and shadow tokens. `:root` defaults to light,
 * `[data-theme="dark"]` forces dark, and a `prefers-color-scheme` media query
 * honors the OS when no explicit scheme is forced (`system`). There is no
 * client bundle, no `<script>`, and no external stylesheet — every rule here is
 * inlined into the document's single `<style>` element.
 *
 * Markup is intentionally styled by element (h1/h2/table/form/…) under `body`
 * plus the existing `admin-*` class hooks, so the rendered class names and
 * structure stay stable for consumers and tests. The core tokens are declared
 * first; the derived tokens override them after, and a `color-mix` palette
 * keeps the scheme coherent without hardcoding a second hex set per mode.
 *
 * CSS emission order is load-bearing: the theme-service and app-customization
 * rules are appended AFTER this block (see `buildThemeCss`), so the default
 * tokens must appear first and `body { margin` stays the last-anchored default
 * rule the customization tests key on.
 */
const ADMIN_THEME_CSS = [
  // Core token layer: only the semver-visible five are set by the base sheet.
  ':root {',
  '  --jsails-bg: #ffffff;',
  '  --jsails-fg: #1b1b1b;',
  '  --jsails-accent: #4f46e5;',
  '  --jsails-muted: #6b7280;',
  '  --jsails-border: #e5e7eb;',
  '}',
  '[data-theme="light"] {',
  '  --jsails-bg: #ffffff;',
  '  --jsails-fg: #1b1b1b;',
  '  --jsails-accent: #4f46e5;',
  '  --jsails-muted: #6b7280;',
  '  --jsails-border: #e5e7eb;',
  '}',
  '[data-theme="dark"] {',
  '  --jsails-bg: #16181d;',
  '  --jsails-fg: #e6e6e6;',
  '  --jsails-accent: #818cf8;',
  '  --jsails-muted: #9aa1ac;',
  '  --jsails-border: #2c3038;',
  '}',
  '@media (prefers-color-scheme: dark) {',
  '  :root {',
  '    --jsails-bg: #16181d;',
  '    --jsails-fg: #e6e6e6;',
  '    --jsails-accent: #818cf8;',
  '    --jsails-muted: #9aa1ac;',
  '    --jsails-border: #2c3038;',
  '  }',
  '}',
  // Derived palette. `color-mix` keeps every surface a shade of the scheme's
  // own background/foreground, so a custom `--jsails-bg`/`--jsails-fg` flows
  // through to cards, hovers, and focus rings without extra app overrides.
  ':root {',
  '  --jsails-surface: color-mix(in srgb, var(--jsails-bg) 96%, var(--jsails-fg));',
  '  --jsails-surface-2: color-mix(in srgb, var(--jsails-bg) 92%, var(--jsails-fg));',
  '  --jsails-hover: color-mix(in srgb, var(--jsails-bg) 88%, var(--jsails-fg));',
  '  --jsails-accent-soft: color-mix(in srgb, var(--jsails-accent) 14%, transparent);',
  '  --jsails-accent-fg: #ffffff;',
  '  --jsails-danger: #dc2626;',
  '  --jsails-success: #16a34a;',
  '  --jsails-radius: 10px;',
  '  --jsails-radius-sm: 6px;',
  '  --jsails-shadow: 0 1px 2px rgba(0, 0, 0, 0.06), 0 4px 12px rgba(0, 0, 0, 0.05);',
  '  --jsails-space: 16px;',
  '}',
  '[data-theme="dark"] {',
  '  --jsails-surface: #1e2128;',
  '  --jsails-surface-2: #23262e;',
  '  --jsails-hover: #2a2e37;',
  '  --jsails-danger: #f87171;',
  '  --jsails-success: #4ade80;',
  '  --jsails-shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 4px 12px rgba(0, 0, 0, 0.35);',
  '}',
  '@media (prefers-color-scheme: dark) {',
  '  :root {',
  '    --jsails-surface: #1e2128;',
  '    --jsails-surface-2: #23262e;',
  '    --jsails-hover: #2a2e37;',
  '    --jsails-danger: #f87171;',
  '    --jsails-success: #4ade80;',
  '    --jsails-shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 4px 12px rgba(0, 0, 0, 0.35);',
  '  }',
  '}',
  // Base document.
  '*, *::before, *::after { box-sizing: border-box; }',
  'body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 15px; line-height: 1.5; background: var(--jsails-bg); color: var(--jsails-fg); padding: 24px; max-width: 1200px; margin-inline: auto; -webkit-text-size-adjust: 100%; }',
  'h1 { font-size: 1.6rem; font-weight: 650; line-height: 1.25; margin: 0 0 16px; letter-spacing: -0.01em; }',
  'h2 { font-size: 1.1rem; font-weight: 600; margin: 28px 0 10px; color: var(--jsails-muted); text-transform: uppercase; letter-spacing: 0.04em; }',
  'h3 { font-size: 1rem; font-weight: 600; margin: 16px 0 8px; }',
  'p { margin: 0 0 12px; }',
  'code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.88em; background: var(--jsails-surface-2); border: 1px solid var(--jsails-border); border-radius: var(--jsails-radius-sm); padding: 1px 5px; }',
  'a { color: var(--jsails-accent); text-decoration: none; }',
  'a:hover { text-decoration: underline; }',
  'hr { border: 0; border-top: 1px solid var(--jsails-border); margin: 24px 0; }',
  // Navigation (dashboard index).
  'nav { margin-top: 12px; }',
  'nav ul { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }',
  'nav li { display: inline-flex; align-items: center; gap: 6px; }',
  'nav a { display: inline-block; padding: 7px 12px; border: 1px solid var(--jsails-border); border-radius: var(--jsails-radius-sm); background: var(--jsails-surface); color: var(--jsails-fg); font-weight: 500; }',
  'nav a:hover { background: var(--jsails-hover); text-decoration: none; border-color: var(--jsails-accent); }',
  'nav li > span { font-size: 0.75rem; font-weight: 600; color: var(--jsails-muted); background: var(--jsails-surface-2); border-radius: 999px; padding: 1px 8px; }',
  // Tables.
  'table { width: 100%; border-collapse: collapse; margin: 4px 0 16px; background: var(--jsails-surface); border: 1px solid var(--jsails-border); border-radius: var(--jsails-radius); overflow: hidden; }',
  'thead th { text-align: left; font-size: 0.78rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--jsails-muted); background: var(--jsails-surface-2); padding: 10px 12px; border-bottom: 1px solid var(--jsails-border); white-space: nowrap; }',
  'thead th a { color: var(--jsails-muted); }',
  'tbody td { padding: 10px 12px; border-bottom: 1px solid var(--jsails-border); vertical-align: top; font-variant-numeric: tabular-nums; }',
  'tbody tr:last-child td { border-bottom: 0; }',
  'tbody tr:hover { background: var(--jsails-hover); }',
  'td:first-child, th:first-child { padding-left: 16px; }',
  'td:last-child, th:last-child { padding-right: 16px; }',
  // Forms.
  'form { margin: 0 0 16px; }',
  'form > div { margin-bottom: 14px; }',
  'label { display: block; font-size: 0.85rem; font-weight: 550; margin-bottom: 5px; color: var(--jsails-fg); }',
  'label input[type="radio"], label input[type="checkbox"] { margin-right: 6px; }',
  'input[type="text"], input[type="number"], input[type="date"], input[type="datetime-local"], input[type="file"], input[type="color"], select, textarea { width: 100%; max-width: 520px; box-sizing: border-box; padding: 8px 10px; font: inherit; font-size: 0.92rem; color: var(--jsails-fg); background: var(--jsails-bg); border: 1px solid var(--jsails-border); border-radius: var(--jsails-radius-sm); transition: border-color 120ms ease, box-shadow 120ms ease; }',
  'input[type="color"] { padding: 2px; height: 38px; max-width: 72px; }',
  'input[type="range"] { max-width: 520px; width: 100%; accent-color: var(--jsails-accent); }',
  'textarea { min-height: 96px; resize: vertical; font-family: inherit; }',
  'input:focus, select:focus, textarea:focus { outline: none; border-color: var(--jsails-accent); box-shadow: 0 0 0 3px var(--jsails-accent-soft); }',
  'input[type="checkbox"], input[type="radio"] { accent-color: var(--jsails-accent); width: auto; }',
  'p[role="alert"] { color: var(--jsails-danger); font-size: 0.85rem; margin: 5px 0 0; }',
  'p[role="status"] { padding: 10px 14px; margin: 0 0 18px; border-radius: var(--jsails-radius-sm); border: 1px solid color-mix(in srgb, var(--jsails-success) 40%, var(--jsails-border)); background: color-mix(in srgb, var(--jsails-success) 12%, transparent); font-size: 0.9rem; }',
  // Buttons.
  'button { font: inherit; font-size: 0.9rem; font-weight: 550; padding: 8px 14px; border-radius: var(--jsails-radius-sm); border: 1px solid transparent; background: var(--jsails-accent); color: var(--jsails-accent-fg); cursor: pointer; transition: filter 120ms ease, background 120ms ease; }',
  'button:hover { filter: brightness(1.08); }',
  'button:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--jsails-accent-soft); }',
  '.admin-repeater button, .admin-repeater-item button { background: var(--jsails-surface-2); color: var(--jsails-fg); border-color: var(--jsails-border); }',
  '.admin-repeater button:hover, .admin-repeater-item button:hover { background: var(--jsails-hover); filter: none; }',
  // Repeater / formset rows.
  '.admin-repeater { margin: 8px 0 16px; }',
  '.admin-repeater fieldset { border: 1px dashed var(--jsails-border); border-radius: var(--jsails-radius); padding: 12px 14px; margin: 0 0 10px; }',
  '.admin-repeater-item { display: grid; gap: 10px; margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--jsails-border); }',
  '.admin-repeater-item:last-child { border-bottom: 0; padding-bottom: 0; }',
  // Status cell formats.
  '.admin-badge { display: inline-block; font-size: 0.78rem; font-weight: 600; padding: 2px 9px; border-radius: 999px; background: var(--jsails-accent-soft); color: var(--jsails-accent); }',
  '.admin-boolean { font-weight: 550; }',
  '.admin-date { color: var(--jsails-muted); font-variant-numeric: tabular-nums; }',
  '.admin-icon { font-size: 1.1rem; }',
  '.admin-color { display: inline-block; width: 18px; height: 18px; border-radius: 4px; border: 1px solid var(--jsails-border); vertical-align: middle; }',
  '.admin-tag { display: inline-block; font-size: 0.76rem; font-weight: 550; padding: 1px 8px; margin: 0 4px 4px 0; border-radius: 999px; background: var(--jsails-surface-2); border: 1px solid var(--jsails-border); color: var(--jsails-fg); }',
  // Relation cells and managers.
  '.admin-relation { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 8px; }',
  '.admin-relation li { font-size: 0.85rem; }',
  '.admin-relation-manager, .admin-relation-inline { margin: 24px 0; padding: 16px; border: 1px solid var(--jsails-border); border-radius: var(--jsails-radius); background: var(--jsails-surface); }',
  // Read-only detail section (infolist).
  'section { margin: 0 0 24px; padding: 16px 18px; border: 1px solid var(--jsails-border); border-radius: var(--jsails-radius); background: var(--jsails-surface); }',
  'section > dl { display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 8px 20px; margin: 0; }',
  'section dt { font-size: 0.82rem; font-weight: 600; color: var(--jsails-muted); }',
  'section dd { margin: 0; }',
  // Widget dashboard.
  '.admin-widgets { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin: 8px 0 24px; }',
  '.admin-widget { display: flex; flex-direction: column; gap: 4px; padding: 18px; border: 1px solid var(--jsails-border); border-radius: var(--jsails-radius); background: var(--jsails-surface); box-shadow: var(--jsails-shadow); }',
  '.admin-widget-value { font-size: 1.9rem; font-weight: 650; line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }',
  '.admin-widget-label { font-size: 0.82rem; font-weight: 550; color: var(--jsails-muted); }',
  // Charts.
  '.admin-charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin: 8px 0 24px; }',
  '.admin-chart-card { padding: 18px; border: 1px solid var(--jsails-border); border-radius: var(--jsails-radius); background: var(--jsails-surface); box-shadow: var(--jsails-shadow); }',
  '.admin-chart-label { display: block; font-size: 0.82rem; font-weight: 600; color: var(--jsails-muted); margin-bottom: 12px; }',
  '.admin-chart-body { width: 100%; }',
  '.admin-chart { display: block; width: 100%; height: auto; overflow: visible; }',
  // Tabs.
  '.admin-tabs { margin: 16px 0; }',
  '.admin-tab-list { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 16px; padding: 4px; border: 1px solid var(--jsails-border); border-radius: var(--jsails-radius-sm); background: var(--jsails-surface-2); }',
  '.admin-tab-btn { background: transparent; color: var(--jsails-muted); border: 0; border-radius: var(--jsails-radius-sm); padding: 6px 12px; }',
  '.admin-tab-btn:hover { background: var(--jsails-hover); color: var(--jsails-fg); filter: none; }',
  // Wizard.
  '.admin-wizard { margin: 16px 0; }',
  '.admin-wizard-steps { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; margin: 0 0 16px; padding: 0; }',
  '.admin-wizard-step-label { display: inline-block; font-size: 0.82rem; font-weight: 550; padding: 4px 12px; border-radius: 999px; background: var(--jsails-surface-2); color: var(--jsails-muted); border: 1px solid var(--jsails-border); }',
  '.admin-wizard-body { margin-bottom: 16px; }',
  '.admin-wizard-footer { display: flex; gap: 8px; }',
  '.admin-wizard-prev, .admin-wizard-next { background: var(--jsails-surface-2); color: var(--jsails-fg); border-color: var(--jsails-border); }',
  '.admin-wizard-prev:hover, .admin-wizard-next:hover { background: var(--jsails-hover); filter: none; }',
  // Grouped tables.
  '.admin-grouped-table { margin: 0 0 16px; }',
  '.admin-group-header { font-size: 0.92rem; font-weight: 600; color: var(--jsails-fg); margin: 20px 0 8px; text-transform: none; letter-spacing: normal; }',
  // Motion preference.
  '@media (prefers-reduced-motion: reduce) {',
  '  * { transition: none !important; animation: none !important; }',
  '}',
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
 *
 * The admin surface is never a public page, so the head always carries a
 * `noindex, nofollow` robots directive — an admin panel must not be indexed.
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
      h(
        'head',
        null,
        h('title', null, options.title),
        h('meta', { name: 'robots', content: 'noindex, nofollow' }),
        h('style', null, css),
      ),
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
