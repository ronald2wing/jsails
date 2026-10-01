/**
 * Feature-flags admin page: a read-only listing of every global flag with an
 * activate/deactivate toggle, rendered as an {@link AdminPage} inside the admin
 * panel.
 *
 * `defineFlagsAdminPage(options)` validates the options (service registry and an
 * optional admin base path) and returns a frozen `AdminPage` descriptor whose
 * `slug` is `flags` and whose `label` is `Feature Flags`. The descriptor is
 * inert until the admin panel mounts it; the page's `render` resolves the
 * {@link FeatureFlags} service from the registry lazily per request so a
 * process restart picks it up, and the page's `handlePost` toggles a single
 * global flag.
 *
 * Only the global scope is managed — scoped flags are app-specific and must be
 * toggled through application code. The page renders an honest note to that
 * effect.
 *
 * The module is ORM-free: it imports only the admin page descriptor,
 * the flags token/plugin, and the feature-flag service contract. It performs no
 * I/O until the page renders or a toggle is submitted.
 */

import { h, type ComponentChild } from 'preact';

import { adminRedirectResponse, renderAdminDocumentWithTheme } from '../admin/document.js';
import { badRequestResponse, notFoundResponse, serverErrorResponse } from '../admin/responses.js';
import { defineNotice } from '../admin/notices.js';
import {
  defineAdminPage,
  type AdminPage,
  type AdminPagePostContext,
  type AdminPageRenderContext,
} from '../admin/page.js';
import type { FeatureFlags } from './flags.js';

/**
 * Options for {@link defineFlagsAdminPage}.
 *
 * Pass `flags` (resolved via {@code services.tryGet(flagsToken)} during setup)
 * or `undefined` when the plugin is not enabled — the page renders "unavailable"
 * rather than a 500. The `path` is the admin panel base path (defaults to
 * `/admin`), used to build the redirect location after a successful toggle.
 */
export interface FlagsAdminPageOptions {
  /** The resolved {@link FeatureFlags} service, or `undefined` when absent. */
  readonly flags?: FeatureFlags;
  /** Admin panel base path. Defaults to `/admin`. */
  readonly path?: string;
}

/** Fixed notice codes for the flags page. */
const FLAG_ACTIVATED = 'flag_activated';
const FLAG_DEACTIVATED = 'flag_deactivated';

/** Recognized notice codes — only the two this page emits. */
const FLAG_NOTICE_CODES = Object.freeze([FLAG_ACTIVATED, FLAG_DEACTIVATED]);

/** Fixed, value-free notice messages. */
const NOTICE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  [FLAG_ACTIVATED]: 'Flag activated.',
  [FLAG_DEACTIVATED]: 'Flag deactivated.',
});

/** The fixed notice definitions, for `AdminPanelOptions.notices`. */
export const FLAGS_ADMIN_NOTICES = Object.freeze([
  defineNotice(FLAG_ACTIVATED, { level: 'success', message: 'Flag activated.' }),
  defineNotice(FLAG_DEACTIVATED, { level: 'success', message: 'Flag deactivated.' }),
]);

/** Recognize a notice query value for the flags page. */
function readFlagNotice(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  return FLAG_NOTICE_CODES.find((code) => code === raw);
}

/**
 * Build a frozen admin-page descriptor for the feature-flags surface.
 *
 * The returned page renders every global flag as a table with activate/deactivate
 * toggle buttons. When `options.flags` is `undefined` (the plugin is not enabled)
 * the page renders an "unavailable" message — fail-closed, consistent with the
 * framework's service-resolution pattern.
 *
 * `options.path` is the admin panel's base path (defaults to `/admin`), used to
 * build the redirect location after a successful toggle.
 */
export function defineFlagsAdminPage(options: FlagsAdminPageOptions = {}): AdminPage {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('defineFlagsAdminPage requires an options object');
  }

  const path = options.path ?? '/admin';
  const flags = options.flags;

  return defineAdminPage({
    slug: 'flags',
    label: 'Feature Flags',
    render: (context) => renderFlagsPage(context, flags, path),
    handlePost: (context) => handleFlagsPost(context, flags, path),
  });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Render the flags page: heading, notice, scope note, table, and back link. */
async function renderFlagsPage(
  context: AdminPageRenderContext,
  flags: FeatureFlags | undefined,
  path: string,
): Promise<string> {
  const notice = readFlagNotice(context.url.searchParams.get('notice'));

  const body: ComponentChild[] = [];

  if (notice !== undefined) {
    body.push(h('p', { role: 'status' }, NOTICE_MESSAGES[notice] ?? notice));
  }

  if (flags === undefined) {
    body.push(h('h1', null, 'Feature Flags'));
    body.push(
      h(
        'p',
        null,
        'The feature-flags plugin is not enabled. Enable the `flags` plugin to manage flags from the admin panel.',
      ),
    );
  } else {
    body.push(await renderFlagList(flags, context, path));
  }

  body.push(h('a', { href: path }, 'Back to dashboard'));

  return renderAdminDocumentWithTheme(
    {
      title: 'Feature Flags',
      theme: context.theme,
      themeCustomization: context.themeCustomization,
      themeTokens: context.themeTokens,
    },
    ...body,
  );
}

/** Render the flag table with toggle buttons for every global flag. */
async function renderFlagList(
  flags: FeatureFlags,
  context: AdminPageRenderContext,
  path: string,
): Promise<ComponentChild> {
  const all: Record<string, boolean> = await flags.all();
  const entries: readonly (readonly [string, boolean])[] = Object.entries(all).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  const children: ComponentChild[] = [];

  children.push(h('h1', null, 'Feature Flags'));

  children.push(
    h(
      'p',
      { class: 'admin-flags-scope-note' },
      'Flags shown below are global only. Scoped flags (per-user, per-tenant) must be toggled through application code.',
    ),
  );

  if (entries.length === 0) {
    children.push(h('p', null, 'No global flags configured.'));
  } else {
    const csrf = context.session.csrfToken;
    children.push(renderFlagsTable(entries, csrf, `${path}/flags`));
  }

  return h('div', null, ...children);
}

/** Render the flags table. */
function renderFlagsTable(
  entries: readonly (readonly [string, boolean])[],
  csrf: string,
  action: string,
): ComponentChild {
  return h(
    'table',
    null,
    h(
      'thead',
      null,
      h('tr', null, h('th', null, 'Flag'), h('th', null, 'Status'), h('th', null, 'Actions')),
    ),
    h('tbody', null, ...entries.map(([key, active]) => renderFlagRow(key, active, csrf, action))),
  );
}

/** Render one flag row: name, active/inactive status, and a toggle form. */
function renderFlagRow(key: string, active: boolean, csrf: string, action: string): ComponentChild {
  const statusLabel = active ? 'active' : 'inactive';
  const nextLabel = active ? 'Deactivate' : 'Activate';

  return h(
    'tr',
    null,
    h('td', null, h('code', null, key)),
    h(
      'td',
      null,
      h(
        'span',
        { class: active ? 'admin-badge' : 'admin-badge admin-badge-inactive' },
        statusLabel,
      ),
    ),
    h(
      'td',
      null,
      h(
        'form',
        { method: 'post', action },
        h('input', { type: 'hidden', name: '_csrf', value: csrf }),
        h('input', { type: 'hidden', name: 'flag_key', value: key }),
        h('input', { type: 'hidden', name: 'flag_active', value: String(!active) }),
        h('button', { type: 'submit' }, nextLabel),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// POST dispatch
// ---------------------------------------------------------------------------

/** Handle the page POST: toggle a single global flag. */
async function handleFlagsPost(
  context: AdminPagePostContext,
  flags: FeatureFlags | undefined,
  path: string,
): Promise<Response> {
  if (flags === undefined) {
    return serverErrorResponse();
  }

  const key = context.body['flag_key'];
  if (key === undefined || key === '') {
    return badRequestResponse();
  }

  const activeValue = context.body['flag_active'];
  if (activeValue === undefined) {
    return badRequestResponse();
  }

  let active: boolean;
  if (activeValue === 'true') {
    active = true;
  } else if (activeValue === 'false') {
    active = false;
  } else {
    return badRequestResponse();
  }

  // Validate the key is a known flag before toggling.
  const all = await flags.all();
  if (!Object.hasOwn(all, key)) {
    return notFoundResponse();
  }

  try {
    if (active) {
      await flags.activate(key);
    } else {
      await flags.deactivate(key);
    }
  } catch {
    return serverErrorResponse();
  }

  const code = active ? FLAG_ACTIVATED : FLAG_DEACTIVATED;
  return adminRedirectResponse(`${path}/flags?notice=${code}`);
}
