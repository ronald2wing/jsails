/**
 * The plugin list page: its render side and its POST handler.
 *
 * The render side is asynchronous: it discovers plugins (honoring the
 * configured `enabled` allow-list and `pluginsDir`) and merges in the persisted
 * plugin state, then renders the list table, a restart notice (from the
 * `notice` query parameter), an install form gated behind
 * {@link resolveDownloadsCapability} plus a configured installer, and the
 * per-row enable/disable/uninstall/rollback actions. Discovery and state-load
 * failures degrade to an empty listing rather than a 500.
 *
 * The POST side dispatches on the submitted `action` field. The core admin
 * panel has already enforced the auth gate, a same-origin `Origin`, and a
 * constant-time `_csrf` check, so this module only applies the plugin manager's
 * own policy and its value-free error responses.
 */

import { h, type ComponentChild, type ComponentChildren } from 'preact';

import type { AdminPagePostContext, AdminPageRenderContext } from '../admin/page.js';
import { adminRedirectResponse, renderAdminDocumentWithTheme } from '../admin/document.js';
import {
  resolveDownloadsCapability,
  type DownloadsCapability,
} from '../plugins/download-capability.js';
import type { PluginInstaller } from '../plugins/installer.js';
import { PLUGIN_ID_PATTERN } from '../plugins/manifest/index.js';
import type { PluginState } from '../plugins/state-store.js';
import { loadPluginData, stateEntry } from './plugin-data.js';
import {
  PLUGIN_NOTICE_DISABLED,
  PLUGIN_NOTICE_ENABLED,
  PLUGIN_NOTICE_INSTALLED,
  PLUGIN_NOTICE_ROLLED_BACK,
  PLUGIN_NOTICE_UNINSTALLED,
  readNotice,
  renderNotice,
  type PluginNoticeCode,
} from './plugin-notices.js';
import {
  badRequestResponse,
  conflictResponse,
  forbiddenWithReasonResponse,
  installFailureResponse,
  notFoundResponse,
  serverErrorResponse,
} from './plugin-manager-responses.js';
import type { ResolvedPluginManagerOptions } from './plugin.js';

/** A plugin row rendered on the plugins page. */
interface PluginManagerRow {
  readonly id: string;
  readonly version: string;
  readonly provenance: string;
  readonly status: string;
  /** Whether the plugin is currently enabled (drives the toggle button label). */
  readonly enabled: boolean;
  /** Whether the row renders an enable/disable action. */
  readonly manageable: boolean;
  /** Whether the plugin has a persisted state entry (installed). */
  readonly installed: boolean;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Render the plugins page: notice, install form, table, and back link. */
export async function renderPluginsPage(
  context: AdminPageRenderContext,
  resolved: ResolvedPluginManagerOptions,
): Promise<string> {
  const rows = await loadPluginRows(resolved);
  const notice = readNotice(context.url.searchParams.get('notice'));
  const csrf = context.session.csrfToken;
  const path = context.path;

  const capability = resolveDownloadsCapability({
    configured: resolved.downloads,
    staticExport: false,
  });
  const installer = resolved.installer;

  const body: ComponentChild[] = [h('h1', null, 'Plugins')];
  if (notice !== undefined) {
    body.push(renderNotice(notice));
  }
  if (capability.enabled && installer !== undefined) {
    body.push(renderInstallForm(path, csrf));
  } else {
    body.push(renderInstallDisabled(capability, installer));
  }
  body.push(renderTable(rows, resolved, path, csrf));
  body.push(h('a', { href: path }, 'Back to dashboard'));

  return renderAdminDocumentWithTheme(
    { title: 'Plugins', theme: context.theme, themeCustomization: context.themeCustomization },
    ...body,
  );
}

/** The install form (id/version/url + optional checksum). */
function renderInstallForm(path: string, csrf: string): ComponentChild {
  return h(
    'form',
    { method: 'post', action: `${path}/plugins` },
    h('input', { type: 'hidden', name: '_csrf', value: csrf }),
    h('input', { type: 'hidden', name: 'action', value: 'install' }),
    h('label', null, 'Plugin id', h('input', { type: 'text', name: 'id' })),
    h('label', null, 'Version', h('input', { type: 'text', name: 'version' })),
    h('label', null, 'Bundle URL', h('input', { type: 'text', name: 'url' })),
    h('label', null, 'SHA-256 (optional)', h('input', { type: 'text', name: 'sha256' })),
    h('button', { type: 'submit' }, 'Install'),
  );
}

/** The install-disabled note, with the capability reason or a missing installer. */
function renderInstallDisabled(
  capability: DownloadsCapability,
  installer: PluginInstaller | undefined,
): ComponentChild {
  const reason =
    installer === undefined
      ? 'plugin installation is not configured'
      : (capability.reason ?? 'downloads are unavailable');
  return h('p', null, reason);
}

/** The plugin list table: id, version, provenance, status, and actions. */
function renderTable(
  rows: readonly PluginManagerRow[],
  resolved: ResolvedPluginManagerOptions,
  path: string,
  csrf: string,
): ComponentChild {
  if (rows.length === 0) {
    return h('p', null, 'No plugins discovered.');
  }
  const installer = resolved.installer;
  const anyActions = rows.some(
    (row) => row.manageable || (row.installed && installer !== undefined),
  );
  return h(
    'table',
    null,
    h(
      'thead',
      null,
      h(
        'tr',
        null,
        h('th', null, 'Plugin'),
        h('th', null, 'Version'),
        h('th', null, 'Provenance'),
        h('th', null, 'Status'),
        ...(anyActions ? [h('th', null, 'Actions')] : []),
      ),
    ),
    h(
      'tbody',
      null,
      ...rows.map((row) =>
        h(
          'tr',
          null,
          h('td', null, row.id),
          h('td', null, row.version),
          h('td', null, row.provenance),
          h('td', null, row.status),
          ...(anyActions ? [h('td', null, renderRowActions(row, path, csrf, installer))] : []),
        ),
      ),
    ),
  );
}

/** Render the per-row action forms (toggle, uninstall, rollback). */
function renderRowActions(
  row: PluginManagerRow,
  path: string,
  csrf: string,
  installer: PluginInstaller | undefined,
): ComponentChildren {
  const actions: ComponentChild[] = [];
  if (row.manageable) {
    const enable = !row.enabled;
    actions.push(
      h(
        'form',
        { method: 'post', action: `${path}/plugins` },
        h('input', { type: 'hidden', name: '_csrf', value: csrf }),
        h('input', { type: 'hidden', name: 'action', value: enable ? 'enable' : 'disable' }),
        h('input', { type: 'hidden', name: 'id', value: row.id }),
        h('button', { type: 'submit' }, enable ? 'Enable' : 'Disable'),
      ),
    );
  }
  if (row.installed && installer !== undefined) {
    actions.push(
      h(
        'form',
        { method: 'post', action: `${path}/plugins` },
        h('input', { type: 'hidden', name: '_csrf', value: csrf }),
        h('input', { type: 'hidden', name: 'action', value: 'uninstall' }),
        h('input', { type: 'hidden', name: 'id', value: row.id }),
        h('button', { type: 'submit' }, 'Uninstall'),
      ),
    );
    actions.push(
      h(
        'form',
        { method: 'post', action: `${path}/plugins` },
        h('input', { type: 'hidden', name: '_csrf', value: csrf }),
        h('input', { type: 'hidden', name: 'action', value: 'rollback' }),
        h('input', { type: 'hidden', name: 'id', value: row.id }),
        h('input', { type: 'text', name: 'version', placeholder: 'version' }),
        h('button', { type: 'submit' }, 'Rollback'),
      ),
    );
  }
  return actions.length === 0 ? '' : actions;
}

// ---------------------------------------------------------------------------
// POST dispatch
// ---------------------------------------------------------------------------

/** Dispatch the page POST on the submitted `action` field. */
export async function handlePluginsPost(
  context: AdminPagePostContext,
  resolved: ResolvedPluginManagerOptions,
): Promise<Response> {
  const action = context.body['action'];
  const redirect = (code: PluginNoticeCode): Response =>
    adminRedirectResponse(`${context.path}/plugins?notice=${code}`);

  switch (action) {
    case 'install':
      return handleInstall(context.body, resolved, redirect);
    case 'enable':
      return handleToggle(context.body, resolved, true, redirect);
    case 'disable':
      return handleToggle(context.body, resolved, false, redirect);
    case 'uninstall':
      return handleUninstall(context.body, resolved, redirect);
    case 'rollback':
      return handleRollback(context.body, resolved, redirect);
    default:
      return badRequestResponse();
  }
}

/** Install a plugin bundle from the submitted id/version/url (and checksum). */
async function handleInstall(
  body: Record<string, string>,
  resolved: ResolvedPluginManagerOptions,
  redirect: (code: PluginNoticeCode) => Response,
): Promise<Response> {
  const capability = resolveDownloadsCapability({
    configured: resolved.downloads,
    staticExport: false,
  });
  if (!capability.enabled) {
    return forbiddenWithReasonResponse(capability.reason ?? 'downloads are unavailable');
  }
  const installer = resolved.installer;
  if (installer === undefined) {
    return forbiddenWithReasonResponse('plugin installation is not configured');
  }

  const id = body['id'];
  if (id === undefined || !PLUGIN_ID_PATTERN.test(id)) {
    return badRequestResponse();
  }
  const version = body['version'];
  if (version === undefined || version.trim() === '') {
    return badRequestResponse();
  }
  const url = body['url'];
  if (url === undefined || url.trim() === '') {
    return badRequestResponse();
  }

  // A plugin enabled in code is managed by the application config, never by the
  // admin installer.
  if ((resolved.enabled ?? []).includes(id)) {
    return conflictResponse();
  }

  const sha256 = body['sha256'];
  const checksums =
    sha256 === undefined || sha256.trim() === ''
      ? undefined
      : { [artifactName(url)]: sha256.trim() };

  try {
    await installer.install({ id, version: version.trim(), url: url.trim(), checksums });
  } catch {
    return installFailureResponse();
  }

  return redirect(PLUGIN_NOTICE_INSTALLED);
}

/** Flip one managed plugin's `enabled` flag. */
async function handleToggle(
  body: Record<string, string>,
  resolved: ResolvedPluginManagerOptions,
  enable: boolean,
  redirect: (code: PluginNoticeCode) => Response,
): Promise<Response> {
  const stateSource = resolved.stateSource;
  if (resolved.managed !== true || stateSource === undefined) {
    return forbiddenWithReasonResponse('plugin state is not managed');
  }

  const id = body['id'];
  if (id === undefined || !PLUGIN_ID_PATTERN.test(id)) {
    return badRequestResponse();
  }

  let state: PluginState;
  try {
    state = await stateSource.load();
  } catch {
    return serverErrorResponse();
  }

  if (!Object.hasOwn(state.plugins, id)) {
    return notFoundResponse();
  }

  const entry = state.plugins[id]!;
  const next: PluginState = {
    version: state.version,
    plugins: {
      ...state.plugins,
      [id]: { ...entry, enabled: enable },
    },
  };

  try {
    await stateSource.save(next);
  } catch {
    return serverErrorResponse();
  }

  return redirect(enable ? PLUGIN_NOTICE_ENABLED : PLUGIN_NOTICE_DISABLED);
}

/** Uninstall a plugin via the configured installer. */
async function handleUninstall(
  body: Record<string, string>,
  resolved: ResolvedPluginManagerOptions,
  redirect: (code: PluginNoticeCode) => Response,
): Promise<Response> {
  const installer = resolved.installer;
  if (installer === undefined) {
    return forbiddenWithReasonResponse('plugin installation is not configured');
  }
  const id = body['id'];
  if (id === undefined || !PLUGIN_ID_PATTERN.test(id)) {
    return badRequestResponse();
  }
  try {
    await installer.uninstall(id);
  } catch {
    return serverErrorResponse();
  }
  return redirect(PLUGIN_NOTICE_UNINSTALLED);
}

/** Roll back a plugin to an already-installed version. */
async function handleRollback(
  body: Record<string, string>,
  resolved: ResolvedPluginManagerOptions,
  redirect: (code: PluginNoticeCode) => Response,
): Promise<Response> {
  const installer = resolved.installer;
  if (installer === undefined) {
    return forbiddenWithReasonResponse('plugin installation is not configured');
  }
  const id = body['id'];
  if (id === undefined || !PLUGIN_ID_PATTERN.test(id)) {
    return badRequestResponse();
  }
  const version = body['version'];
  if (version === undefined || version.trim() === '') {
    return badRequestResponse();
  }
  try {
    await installer.rollback(id, version.trim());
  } catch {
    return serverErrorResponse();
  }
  return redirect(PLUGIN_NOTICE_ROLLED_BACK);
}

// ---------------------------------------------------------------------------
// Plugin list loading
// ---------------------------------------------------------------------------

/**
 * Discover plugins (honoring the `enabled` allow-list and `pluginsDir`) and
 * merge in the persisted plugin state. Active plugins show their manifest
 * version, provenance, and an `enabled`/`disabled` status (disabled when the
 * state records `enabled: false`); skipped ids show their skip reason. A row is
 * manageable only in managed mode and only when the state records an entry for
 * that id; a row is installed when the state records an entry. Discovery and
 * state-load failures degrade to an empty listing rather than a 500.
 */
async function loadPluginRows(
  resolved: ResolvedPluginManagerOptions,
): Promise<readonly PluginManagerRow[]> {
  const { discovered, state } = await loadPluginData(resolved);
  const managed = resolved.managed === true && resolved.stateSource !== undefined;

  const active = (discovered?.plugins ?? []).map((plugin) => {
    const entry = stateEntry(state, plugin.id);
    const enabled = entry?.enabled !== false;
    return {
      id: plugin.id,
      version: plugin.version,
      provenance: plugin.source,
      status: enabled ? 'enabled' : 'disabled',
      enabled,
      manageable: managed && entry !== undefined,
      installed: entry !== undefined,
    };
  });
  const skipped = (discovered?.skipped ?? []).map((entry) => ({
    id: entry.id,
    version: '-',
    provenance: '-',
    status: `skipped: ${entry.reason}`,
    enabled: false,
    manageable: false,
    installed: false,
  }));

  return [...active, ...skipped];
}

/** Derive the bundle artifact name from a URL's path basename (query/fragment stripped). */
function artifactName(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.split(/[?#]/)[0] ?? '';
  }
  const segments = pathname.split('/').filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? '';
}
