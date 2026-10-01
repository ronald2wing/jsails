/**
 * Plugin notice codes and the fixed restart banners rendered on the plugin
 * manager pages.
 *
 * The codes are the stable query values a successful mutation redirects to
 * (`<path>/plugins?notice=<code>`); a recognized code maps to a fixed,
 * value-free message. Unknown query values render nothing.
 */

import { h, type ComponentChild } from 'preact';

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

/** Recognize a notice query value, or `undefined` for anything else. */
export function readNotice(raw: string | null): PluginNoticeCode | undefined {
  if (raw === null) return undefined;
  return PLUGIN_NOTICE_CODES.find((code) => code === raw);
}

/** Render the fixed restart notice banner for a recognized code. */
export function renderNotice(code: PluginNoticeCode): ComponentChild {
  return h('p', { role: 'status' }, NOTICE_MESSAGES[code]);
}
