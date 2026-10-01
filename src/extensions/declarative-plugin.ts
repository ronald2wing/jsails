/**
 * Declarative plugin DSL: a thin data-to-imperative adapter over
 * {@link definePlugin} and the {@link PluginContext} contract.
 *
 * `defineDeclarativePlugin(spec)` turns a declaration into a working
 * {@link JsailsPlugin} whose `setup` auto-registers the declared `provide`
 * entries, wires the `http` hook through {@link PluginContext.configureHttp},
 * and then runs the optional `setup` callback. It never reimplements the
 * extension runner — it reshapes a declarative object into the imperative
 * contract the runner already consumes.
 *
 * ```ts
 * const plugin = defineDeclarativePlugin({
 *   name: 'clock',
 *   provide: [[clockToken, { now: () => new Date().toISOString() }]],
 *   http: (app) => app.get('/time', ...),
 *   commands: [{ name: 'time', summary: 'show time', run: () => { console.log(new Date()); } }],
 * });
 * ```
 *
 * `provide` entries are `[token, value]` tuples — the token is the opaque
 * {@link ServiceToken} object (created by {@link createServiceToken}), not a
 * name string. Passing a non-token key throws a value-free
 * {@link DeclarativePluginError}.
 */

import type { HttpExtensionHook, ExtensionCleanup } from './extension.js';
import type { JsailsPlugin, PluginContext, PluginDescription } from './plugin-contract.js';
import type { ServiceToken } from './services.js';
import type { ContractToken } from './contracts.js';
import type { CliCommand } from '../cli/command-registry.js';
import type { DeploymentGenerator } from '../deploy/registry.js';
import type { PageRenderer } from '../contracts/render.js';

// Re-exported for consumer convenience — the core type lives in plugin-contract.js.
export type { JsailsPlugin };

/** Machine-readable failure reason for {@link DeclarativePluginError}. */
export type DeclarativePluginErrorCode =
  'invalid_name' | 'invalid_provide_key' | 'invalid_provide_entry';

/**
 * Raised for invalid declarative-plugin input. Messages carry the error code,
 * never user-provided values, keys, or tokens.
 */
export class DeclarativePluginError extends Error {
  readonly code: DeclarativePluginErrorCode;

  constructor(code: DeclarativePluginErrorCode, message: string) {
    super(message);
    this.name = 'DeclarativePluginError';
    this.code = code;
  }
}

function isTokenLike(value: unknown): value is { readonly name: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).name === 'string'
  );
}

/** The declarative input shape. Everything except `name` is optional. */
export interface DeclarativePluginSpec {
  /** Unique, non-empty plugin name. */
  readonly name: string;
  /** Tokens this plugin requires before its setup runs. */
  readonly requires?: readonly (ServiceToken<unknown> | ContractToken<unknown>)[];
  /** Token → value pairs registered via {@link PluginContext.services}.provide. */
  readonly provide?: Iterable<readonly [ServiceToken<unknown>, unknown]>;
  /** Hook wired through {@link PluginContext.configureHttp}. */
  readonly http?: HttpExtensionHook;
  /** CLI commands carried through by identity, never invoked by the wrapper. */
  readonly commands?: readonly CliCommand[];
  /**
   * Optional extra setup logic. Runs after `provide` and `http` are wired.
   * Receives the full {@link PluginContext} so the caller can register
   * interceptors, observers, middleware, or serve hooks.
   */
  readonly setup?: (
    context: PluginContext,
  ) => void | ExtensionCleanup | Promise<void | ExtensionCleanup>;
  /** Optional static descriptor (see {@link JsailsPlugin.describe}). */
  readonly describe?: () => PluginDescription;
  /** Custom deployment generators carried through by identity. */
  readonly deployments?: readonly DeploymentGenerator[];
  /** Page renderer carried through by identity. */
  readonly renderer?: PageRenderer;
  /** Ordering key; see {@link JsailsPlugin.priority}. */
  readonly priority?: number;
  /** When `true`, the plugin is filtered out before setup. */
  readonly disabled?: boolean;
}

/**
 * Turn a declarative spec into a working {@link JsailsPlugin} whose `setup`
 * automatically registers `provide` entries, wires the `http` hook, and then
 * delegates to the optional `setup` callback.
 *
 * Validation happens eagerly (invalid `name` or `provide` entries throw
 * {@link DeclarativePluginError}) so a broken plugin is caught before any
 * setup runs.
 */
export function defineDeclarativePlugin(spec: DeclarativePluginSpec): JsailsPlugin {
  const { name } = spec;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new DeclarativePluginError('invalid_name', 'plugin name must be a non-empty string');
  }

  const provideEntries: readonly (readonly [ServiceToken<unknown>, unknown])[] | undefined =
    spec.provide === undefined ? undefined : [...spec.provide];

  // Eager validation: every provide entry must be a [token, value] pair with a
  // token-like key (runtime structural check — the compile-time brand can't be
  // inspected, but a non-object-or-array key with a string `name` is rejected).
  if (provideEntries !== undefined) {
    for (const entry of provideEntries) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new DeclarativePluginError(
          'invalid_provide_entry',
          'each provide entry must be a [token, value] pair',
        );
      }
      const [token] = entry;
      if (!isTokenLike(token)) {
        throw new DeclarativePluginError(
          'invalid_provide_key',
          'each provide entry key must be a service token (created by createServiceToken)',
        );
      }
    }
  }

  const {
    requires,
    http,
    commands,
    setup: userSetup,
    describe,
    deployments,
    renderer,
    priority,
    disabled,
  } = spec;

  return {
    name,
    requires,
    commands,
    deployments,
    renderer,
    describe,
    priority,
    disabled,
    setup(context: PluginContext): void | ExtensionCleanup | Promise<void | ExtensionCleanup> {
      if (provideEntries !== undefined) {
        for (const [token, value] of provideEntries) {
          context.services.provide(token, value);
        }
      }

      if (http !== undefined) {
        context.configureHttp(http);
      }

      if (userSetup !== undefined) {
        return userSetup(context);
      }
    },
  };
}
