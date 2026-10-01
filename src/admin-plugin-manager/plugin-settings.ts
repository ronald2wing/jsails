/**
 * The plugin settings page: its render side and its POST handler.
 *
 * One form is rendered per installed plugin whose manifest declares a
 * `settingsSchema`; interpretable fields (string/number/boolean) render as
 * editable inputs, unknown shapes render as read-only JSON textareas that are
 * never submitted. The POST rebuilds the entry's settings from the
 * interpretable submitted fields, preserving unknown keys, and persists through
 * the managed state source. Only available in managed mode; every failure is a
 * value-free error response.
 */

import { h, type ComponentChild } from 'preact';

import type { AdminPagePostContext, AdminPageRenderContext } from '../admin/page.js';
import { adminRedirectResponse, renderAdminDocumentWithTheme } from '../admin/document.js';
import { PLUGIN_ID_PATTERN } from '../plugins/manifest/index.js';
import type { PluginState } from '../plugins/state-store.js';
import { loadPluginData } from './plugin-data.js';
import { PLUGIN_NOTICE_SETTINGS_SAVED, readNotice, renderNotice } from './plugin-notices.js';
import {
  badRequestResponse,
  forbiddenWithReasonResponse,
  notFoundResponse,
  serverErrorResponse,
} from './plugin-manager-responses.js';
import type { ResolvedPluginManagerOptions } from './plugin.js';

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

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// POST dispatch
// ---------------------------------------------------------------------------

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
