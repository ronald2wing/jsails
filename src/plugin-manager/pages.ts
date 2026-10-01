/**
 * Plugin manager pages: the server-rendered plugin list and its POST handler.
 *
 * The render side is asynchronous: it discovers plugins (`discoverPlugins`,
 * honoring the configured `enabled` allow-list and `pluginsDir`) and merges in
 * the persisted plugin state, then renders the list table, a restart notice
 * (from the `notice` query parameter), an install form gated behind
 * {@link resolveDownloadsCapability} plus a configured installer, and the
 * per-row enable/disable/uninstall/rollback actions. Discovery and state-load
 * failures degrade to an empty listing rather than a 500.
 *
 * The POST side dispatches on the submitted `action` field. The core admin
 * panel has already enforced the auth gate, a same-origin `Origin`, and a
 * constant-time `_csrf` check, so this module only applies the plugin manager's
 * own policy and its value-free error responses.
 *
 * This module imports only the admin page descriptors and helpers plus the
 * plugin-system discovery/state/installer modules; it never imports the admin
 * route registrar.
 */

import { join } from 'node:path';

import { h, type ComponentChild, type ComponentChildren } from 'preact';

import type { AdminPagePostContext, AdminPageRenderContext } from '../admin/page.js';
import {
  adminHtmlResponse,
  adminRedirectResponse,
  renderAdminDocument,
  renderAdminDocumentWithTheme,
} from '../admin/document.js';
import {
  DEFAULT_PLUGINS_DIR,
  discoverPlugins,
  type DiscoverPluginsResult,
} from '../plugins/discovery.js';
import {
  resolveDownloadsCapability,
  type DownloadsCapability,
} from '../plugins/download-capability.js';
import type { PluginInstaller } from '../plugins/installer.js';
import { PLUGIN_ID_PATTERN } from '../plugins/manifest.js';
import {
  PLUGIN_STATE_VERSION,
  PluginStateStore,
  type PluginState,
} from '../plugins/state-store.js';
import type { ResolvedPluginManagerOptions } from './plugin.js';

/** Notice code carried on the redirect after a successful install. */
export const PLUGIN_NOTICE_INSTALLED = 'installed';

/** Notice code carried on the redirect after a successful enable. */
export const PLUGIN_NOTICE_ENABLED = 'enabled';

/** Notice code carried on the redirect after a successful disable. */
export const PLUGIN_NOTICE_DISABLED = 'disabled';

/** Notice code carried on the redirect after a successful uninstall. */
export const PLUGIN_NOTICE_UNINSTALLED = 'uninstalled';

/** Notice code carried on the redirect after a successful rollback. */
export const PLUGIN_NOTICE_ROLLED_BACK = 'rolled_back';

/** Notice code carried on the redirect after a successful settings save. */
export const PLUGIN_NOTICE_SETTINGS_SAVED = 'settings_saved';

/** Every plugin notice code, in a stable order. */
export const PLUGIN_NOTICE_CODES = Object.freeze([
  PLUGIN_NOTICE_INSTALLED,
  PLUGIN_NOTICE_ENABLED,
  PLUGIN_NOTICE_DISABLED,
  PLUGIN_NOTICE_UNINSTALLED,
  PLUGIN_NOTICE_ROLLED_BACK,
  PLUGIN_NOTICE_SETTINGS_SAVED,
]);

/** A recognized plugin notice code. */
export type PluginNoticeCode = (typeof PLUGIN_NOTICE_CODES)[number];

/** Fixed, value-free restart notice per code, rendered on the plugins page. */
const NOTICE_MESSAGES: Readonly<Record<PluginNoticeCode, string>> = {
  [PLUGIN_NOTICE_INSTALLED]: 'Plugin installed. Restart the server to apply the change.',
  [PLUGIN_NOTICE_ENABLED]: 'Plugin enabled. Restart the server to apply the change.',
  [PLUGIN_NOTICE_DISABLED]: 'Plugin disabled. Restart the server to apply the change.',
  [PLUGIN_NOTICE_UNINSTALLED]: 'Plugin uninstalled. Restart the server to apply the change.',
  [PLUGIN_NOTICE_ROLLED_BACK]: 'Plugin rolled back. Restart the server to apply the change.',
  [PLUGIN_NOTICE_SETTINGS_SAVED]: 'Plugin settings saved.',
};

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

/** Render the fixed restart notice banner for a recognized code. */
function renderNotice(code: PluginNoticeCode): ComponentChild {
  return h('p', { role: 'status' }, NOTICE_MESSAGES[code]);
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

/** Discover plugins and load persisted state, degrading failures to empty data. */
async function loadPluginData(
  resolved: ResolvedPluginManagerOptions,
): Promise<{ discovered: DiscoverPluginsResult | undefined; state: PluginState }> {
  const pluginsDir = resolved.pluginsDir ?? join(process.cwd(), DEFAULT_PLUGINS_DIR);

  let discovered: DiscoverPluginsResult | undefined;
  try {
    discovered = discoverPlugins({
      rootDir: process.cwd(),
      pluginsDir: resolved.pluginsDir,
      enabled: resolved.enabled,
    });
  } catch {
    discovered = undefined;
  }

  let state: PluginState;
  try {
    if (resolved.stateSource !== undefined) {
      state = await resolved.stateSource.load();
    } else {
      state = new PluginStateStore({ pluginsDir }).load();
    }
  } catch {
    state = { version: PLUGIN_STATE_VERSION, plugins: {} };
  }

  return { discovered, state };
}

/** Read a plugin's state entry without ever touching the prototype chain. */
function stateEntry(state: PluginState, id: string) {
  return Object.hasOwn(state.plugins, id) ? state.plugins[id] : undefined;
}

// ---------------------------------------------------------------------------
// Plugin settings
// ---------------------------------------------------------------------------

/** Upper bound on interpretable settings fields rendered per plugin. */
const MAX_SETTINGS_FIELDS = 100;

/** Upper bound on a submitted setting value length. */
const MAX_SETTING_VALUE_LENGTH = 4096;

/** An interpretable settings field (string/number/boolean). */
interface TypedSettingsField {
  readonly kind: 'string' | 'number' | 'boolean';
  readonly key: string;
  readonly label: string;
  readonly defaultValue?: string | number | boolean;
}

/** A settings field whose schema shape is unknown (rendered read-only). */
interface UnknownSettingsField {
  readonly kind: 'unknown';
  readonly key: string;
}

type SettingsField = TypedSettingsField | UnknownSettingsField;

/**
 * Render the plugin settings page: one form per installed plugin whose manifest
 * declares a `settingsSchema`. Interpretable fields (string/number/boolean)
 * render as editable inputs; unknown shapes render as read-only JSON textareas
 * that are never submitted. Only available in managed mode.
 */
export async function renderPluginSettingsPage(
  context: AdminPageRenderContext,
  resolved: ResolvedPluginManagerOptions,
): Promise<string> {
  const notice = readNotice(context.url.searchParams.get('notice'));
  const path = context.path;
  const body: ComponentChild[] = [h('h1', null, 'Plugin Settings')];
  if (notice !== undefined) {
    body.push(renderNotice(notice));
  }

  const managed = resolved.managed === true && resolved.stateSource !== undefined;
  if (!managed) {
    body.push(h('p', null, 'Plugin settings require a managed plugin state source.'));
  } else {
    body.push(...(await renderPluginSettingsForms(resolved, path, context.session.csrfToken)));
  }

  body.push(h('a', { href: path }, 'Back to dashboard'));
  return renderAdminDocumentWithTheme(
    {
      title: 'Plugin Settings',
      theme: context.theme,
      themeCustomization: context.themeCustomization,
    },
    ...body,
  );
}

/** Render a settings section per installed plugin that declares a schema. */
async function renderPluginSettingsForms(
  resolved: ResolvedPluginManagerOptions,
  path: string,
  csrf: string,
): Promise<ComponentChild[]> {
  const { discovered, state } = await loadPluginData(resolved);
  const installed = (discovered?.plugins ?? []).filter((plugin) =>
    Object.hasOwn(state.plugins, plugin.id),
  );
  if (installed.length === 0) {
    return [h('p', null, 'No installed plugins to configure.')];
  }
  return installed.map((plugin) =>
    renderSettingsSection(
      plugin.id,
      plugin.manifest.settingsSchema,
      state.plugins[plugin.id]?.settings,
      path,
      csrf,
    ),
  );
}

/** One plugin's settings section: heading plus a form when fields exist. */
function renderSettingsSection(
  id: string,
  settingsSchema: Readonly<Record<string, unknown>> | undefined,
  current: Record<string, unknown> | undefined,
  path: string,
  csrf: string,
): ComponentChild {
  const fields = interpretSettingsFields(settingsSchema);
  if (fields.length === 0) {
    return h('section', null, h('h2', null, id), h('p', null, 'No configurable settings.'));
  }
  const controls: ComponentChild[] = fields.map((field) =>
    field.kind === 'unknown'
      ? renderUnknownField(field, current)
      : renderTypedField(field, current),
  );
  return h(
    'section',
    null,
    h('h2', null, id),
    h(
      'form',
      { method: 'post', action: `${path}/plugin-settings` },
      h('input', { type: 'hidden', name: '_csrf', value: csrf }),
      h('input', { type: 'hidden', name: 'action', value: 'save-settings' }),
      h('input', { type: 'hidden', name: 'id', value: id }),
      ...controls,
      h('button', { type: 'submit' }, 'Save settings'),
    ),
  );
}

/** Render an editable input for a typed field, pre-filled from current settings. */
function renderTypedField(
  field: TypedSettingsField,
  current: Record<string, unknown> | undefined,
): ComponentChild {
  const id = `setting-${field.key}`;
  if (field.kind === 'boolean') {
    return h(
      'label',
      { htmlFor: id },
      h('input', {
        type: 'checkbox',
        name: field.key,
        id,
        value: 'on',
        ...(fieldBooleanValue(field, current) ? { checked: true } : {}),
      }),
      ` ${field.label}`,
    );
  }
  return h(
    'div',
    null,
    h('label', { htmlFor: id }, field.label),
    h('input', {
      type: field.kind === 'number' ? 'number' : 'text',
      name: field.key,
      id,
      value: fieldStringValue(field, current),
    }),
  );
}

/** Render a read-only textarea for an unknown-shaped field (never submitted). */
function renderUnknownField(
  field: UnknownSettingsField,
  current: Record<string, unknown> | undefined,
): ComponentChild {
  const value = current?.[field.key];
  return h(
    'div',
    null,
    h('label', null, field.key),
    h('textarea', { readonly: true }, value === undefined ? '' : jsonStringify(value)),
  );
}

/** Resolve a string/number field's input value (current, then default, else ''). */
function fieldStringValue(
  field: TypedSettingsField,
  current: Record<string, unknown> | undefined,
): string {
  const currentValue = current?.[field.key];
  if (currentValue !== undefined && currentValue !== null) {
    return String(currentValue);
  }
  if (field.defaultValue !== undefined) {
    return String(field.defaultValue);
  }
  return '';
}

/** Resolve a boolean field's checked state (current, then default, else false). */
function fieldBooleanValue(
  field: TypedSettingsField,
  current: Record<string, unknown> | undefined,
): boolean {
  const currentValue = current?.[field.key];
  if (typeof currentValue === 'boolean') {
    return currentValue;
  }
  return field.defaultValue === true;
}

/** Interpret a manifest `settingsSchema` into a bounded field list. */
function interpretSettingsFields(
  schema: Readonly<Record<string, unknown>> | undefined,
): SettingsField[] {
  if (schema === undefined) {
    return [];
  }
  return Object.entries(schema)
    .slice(0, MAX_SETTINGS_FIELDS)
    .map(([key, raw]) => interpretSettingsField(key, raw));
}

/**
 * Interpret one `settingsSchema` entry. A `'string'|'number'|'boolean'` shorthand
 * or a `{ type, label?, default? }` object is editable; anything else (including
 * the dangerous prototype keys) is unknown and read-only.
 */
function interpretSettingsField(key: string, raw: unknown): SettingsField {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    return { kind: 'unknown', key };
  }
  if (raw === 'string' || raw === 'number' || raw === 'boolean') {
    return { kind: raw, key, label: key };
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    const type = record['type'];
    if (type === 'string' || type === 'number' || type === 'boolean') {
      const label = typeof record['label'] === 'string' ? record['label'] : key;
      const defaultValue = record['default'];
      if (type === 'string') {
        return typeof defaultValue === 'string'
          ? { kind: type, key, label, defaultValue }
          : { kind: type, key, label };
      }
      if (type === 'number') {
        return typeof defaultValue === 'number'
          ? { kind: type, key, label, defaultValue }
          : { kind: type, key, label };
      }
      return typeof defaultValue === 'boolean'
        ? { kind: type, key, label, defaultValue }
        : { kind: type, key, label };
    }
  }
  return { kind: 'unknown', key };
}

/**
 * Handle the settings page POST: validate the target id against the managed
 * state, rebuild the entry's settings from the interpretable submitted fields,
 * and persist. Value-free errors for every failure.
 */
export async function handlePluginSettingsPost(
  context: AdminPagePostContext,
  resolved: ResolvedPluginManagerOptions,
): Promise<Response> {
  if (context.body['action'] !== 'save-settings') {
    return badRequestResponse();
  }
  const stateSource = resolved.stateSource;
  if (resolved.managed !== true || stateSource === undefined) {
    return forbiddenWithReasonResponse('plugin state is not managed');
  }
  const id = context.body['id'];
  if (id === undefined || !PLUGIN_ID_PATTERN.test(id)) {
    return badRequestResponse();
  }

  const { discovered, state } = await loadPluginData(resolved);
  const manifest = discovered?.plugins.find((plugin) => plugin.id === id)?.manifest;
  if (manifest === undefined) {
    return notFoundResponse();
  }
  if (!Object.hasOwn(state.plugins, id)) {
    return notFoundResponse();
  }

  const entry = state.plugins[id]!;
  let settings: Record<string, unknown>;
  try {
    settings = buildSettings(
      interpretSettingsFields(manifest.settingsSchema),
      context.body,
      entry.settings,
    );
  } catch {
    return badRequestResponse();
  }

  const next: PluginState = {
    version: state.version,
    plugins: { ...state.plugins, [id]: { ...entry, settings } },
  };
  try {
    await stateSource.save(next);
  } catch {
    return serverErrorResponse();
  }

  return adminRedirectResponse(
    `${context.path}/plugin-settings?notice=${PLUGIN_NOTICE_SETTINGS_SAVED}`,
  );
}

/** Build the next settings object: preserve unknown keys, apply submitted fields. */
function buildSettings(
  fields: readonly SettingsField[],
  body: Record<string, string>,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existing ?? {})) {
    settings[key] = value;
  }
  for (const field of fields) {
    if (field.kind === 'unknown') {
      continue;
    }
    if (field.kind === 'boolean') {
      settings[field.key] = body[field.key] === 'on';
      continue;
    }
    const raw = body[field.key];
    if (raw === undefined) {
      if (field.defaultValue !== undefined) {
        settings[field.key] = field.defaultValue;
      } else {
        delete settings[field.key];
      }
      continue;
    }
    if (raw.length > MAX_SETTING_VALUE_LENGTH) {
      throw new Error('setting value too long');
    }
    if (field.kind === 'number') {
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new Error('invalid number');
      }
      settings[field.key] = value;
      continue;
    }
    settings[field.key] = raw;
  }
  return settings;
}

/** JSON-stringify a settings value for the read-only textarea; never throws. */
function jsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/** A 403 carrying a stable, value-free reason (never raw error text). */
function forbiddenWithReasonResponse(reason: string): Response {
  return adminHtmlResponse(
    renderAdminDocument('Forbidden', undefined, h('h1', null, 'Forbidden'), h('p', null, reason)),
    403,
  );
}

/** A value-free 404 document. */
function notFoundResponse(): Response {
  return adminHtmlResponse(
    renderAdminDocument('Not Found', undefined, h('h1', null, 'Not Found')),
    404,
  );
}

/** A 409 for an install targeting a code-managed plugin id. */
function conflictResponse(): Response {
  return adminHtmlResponse(
    renderAdminDocument(
      'Conflict',
      undefined,
      h('h1', null, 'Conflict'),
      h('p', null, 'This plugin is managed by the application configuration.'),
    ),
    409,
  );
}

/** A value-free 400 for a malformed request. */
function badRequestResponse(): Response {
  return adminHtmlResponse(
    renderAdminDocument('Bad Request', undefined, h('h1', null, 'Bad Request')),
    400,
  );
}

/** A value-free 400 for a failed install; the cause is never emitted. */
function installFailureResponse(): Response {
  return adminHtmlResponse(
    renderAdminDocument(
      'Install Failed',
      undefined,
      h('h1', null, 'Install Failed'),
      h('p', null, 'The plugin could not be installed.'),
    ),
    400,
  );
}

/** A value-free 500 document; internal details are never emitted. */
function serverErrorResponse(): Response {
  return adminHtmlResponse(
    renderAdminDocument('Internal Server Error', undefined, h('h1', null, 'Internal Server Error')),
    500,
  );
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Recognize a notice query value, or `undefined` for anything else. */
function readNotice(raw: string | null): PluginNoticeCode | undefined {
  if (raw === null) return undefined;
  return PLUGIN_NOTICE_CODES.find((code) => code === raw);
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
