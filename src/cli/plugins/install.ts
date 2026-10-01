/**
 * The `install`/`uninstall` lifecycle subcommands. They manage installed
 * bundles through the plugin installer and never evaluate plugin code; every
 * failure is value-free and exits non-zero.
 */

import { resolve } from 'node:path';

import { DEFAULT_APP_CONFIG_PATH } from '../../app/config/index.js';
import { formatError } from '../../internal/errors.js';
import { createPluginInstaller } from '../../plugins/installer.js';

import type { ParsedValues, PluginsDeps } from '../plugins-command.js';
import { resolvePluginsDir } from './list.js';
import {
  defaultLoadAppPlugins,
  fail,
  safeMessage,
  usageError,
  type AppPluginSettings,
} from './state.js';

/**
 * `install`: refuse a code-enabled id, then download/verify/install the bundle.
 * The conflict check reads the app config's `plugins.enabled` when the config is
 * present; a broken config is surfaced value-free so no installer step runs.
 */
export async function runInstall(
  id: string,
  values: ParsedValues,
  deps: PluginsDeps,
): Promise<number> {
  if (values.version === undefined) {
    return usageError(deps, 'plugins install requires --version');
  }
  if (values.url === undefined) {
    return usageError(deps, 'plugins install requires --url');
  }
  const version = values.version;
  const url = values.url;

  const appConfigPath = resolve(deps.cwd, DEFAULT_APP_CONFIG_PATH);
  let settings: AppPluginSettings | undefined;
  try {
    settings = await (deps.loadAppPlugins ?? defaultLoadAppPlugins)(appConfigPath);
  } catch (error) {
    return fail(deps, safeMessage(error, 'the app config could not be read'));
  }
  if ((settings?.enabled ?? []).includes(id)) {
    return fail(
      deps,
      `plugin ${JSON.stringify(id)} is code-enabled in the app config; refusing to install over it`,
    );
  }

  let pluginsDir: string;
  try {
    pluginsDir = resolvePluginsDir(deps.cwd, values.dir);
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return 1;
  }

  const installer = (deps.createInstaller ?? createPluginInstaller)({ pluginsDir });

  const sha256 = values.sha256?.trim();
  const checksums =
    sha256 === undefined || sha256 === '' ? undefined : { [artifactName(url)]: sha256 };

  try {
    const result = await installer.install({
      id,
      version,
      url,
      checksums,
      signature: values.signature,
      force: values.force,
    });
    deps.stdout(`Installed ${result.id}@${result.version}.`);
    for (const warning of result.warnings) {
      deps.stderr(`jsails: warning: ${warning}`);
    }
    return 0;
  } catch (error) {
    return fail(deps, safeMessage(error, 'plugin install failed'));
  }
}

/** `uninstall`: remove the installed bundle through the installer. */
export async function runUninstall(
  id: string,
  values: ParsedValues,
  deps: PluginsDeps,
): Promise<number> {
  let pluginsDir: string;
  try {
    pluginsDir = resolvePluginsDir(deps.cwd, values.dir);
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return 1;
  }

  const installer = (deps.createInstaller ?? createPluginInstaller)({ pluginsDir });
  try {
    await installer.uninstall(id, { force: values.force === true });
    deps.stdout(`Uninstalled ${id}.`);
    return 0;
  } catch (error) {
    return fail(deps, safeMessage(error, 'plugin uninstall failed'));
  }
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
