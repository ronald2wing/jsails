/**
 * JSails plugins: the packageable, extendable superset of the plain extension.
 *
 * A plugin is an extension with two additions:
 *
 * - declarative passthroughs (`deployments`, `renderer`) carried by identity for
 *   the config loader, never validated, collected, or invoked by the runner;
 * - a {@link PluginContext} whose `setup` can additionally register interceptors
 *   and observers against the per-application registry (see
 *   `src/extensions/interceptors.ts`).
 *
 * `priority` (default `0`, lower runs first), `disabled`, `requires`,
 * `provides`, and `commands` are inherited from {@link JsailsExtension}, so a
 * plugin participates in the same contract-ordered setup phase as every
 * extension. A plugin compiles to the low-level
 * {@link JsailsExtension} shape at runtime — the `extensions:` config key and
 * the plain {@link JsailsExtension} remain the underlying mechanism the runner
 * consumes.
 *
 * Everything below is type-only or an identity helper, so importing this module
 * never pulls an ORM, HTTP, queue, or Socket.IO runtime into the extension
 * foundation subpath.
 */

import type { PageRenderer } from '../contracts/render.js';
import type { DeploymentGenerator } from '../deploy/registry.js';
import type { CliCommand, CommandAudience } from '../cli/command-registry.js';
import type { ExtensionCleanup, ExtensionContext, JsailsExtension } from './extension.js';
import type {
  AfterInterceptor,
  BeforeInterceptor,
  EventToken,
  InterceptorRegistry,
  Observer,
  OperationToken,
} from './interceptors.js';

/**
 * The setup context handed to a plugin's `setup`. It extends the extension
 * context with interceptor and observer registration; `priority` is the
 * plugin's own and is bound by the runner, so it is never passed here.
 */
export interface PluginContext extends ExtensionContext {
  /** Register a before hook for `operation` (or an after hook via `phase`). */
  intercept<TArgs = unknown, TResult = unknown>(
    operation: OperationToken<TArgs, TResult>,
    fn: BeforeInterceptor<TArgs>,
    options?: { phase?: 'before' },
  ): void;
  intercept<TArgs = unknown, TResult = unknown>(
    operation: OperationToken<TArgs, TResult>,
    fn: AfterInterceptor<TArgs, TResult>,
    options: { phase: 'after' },
  ): void;
  /** Register an observer for `event`. */
  observe<TPayload = unknown>(event: EventToken<TPayload>, fn: Observer<TPayload>): void;
  /**
   * Read-only handle to the shared interceptor/observer registry. A plugin can
   * wrap this as a service rather than creating an isolated local registry.
   * Registration is still guarded by the registry's own seal after setup.
   */
  readonly interceptorRegistry: InterceptorRegistry;
}

/**
 * A packageable unit of functionality: an extension plus declarative
 * deployments/renderer passthroughs and a setup context that can register
 * interceptors and observers. `name`, `requires`, `provides`, `commands`,
 * `priority`, and `disabled` are inherited from {@link JsailsExtension}.
 */
export interface JsailsPlugin extends JsailsExtension {
  /** Custom deployment generators carried through by identity, never invoked. */
  readonly deployments?: readonly DeploymentGenerator[];
  /** Page renderer carried through by identity, never invoked. */
  readonly renderer?: PageRenderer;
  /**
   * Declarative metadata readable without running `setup`. Pure, side-effect-free,
   * and never invokes callbacks, signs snapshots, or performs I/O. Add fields
   * only as concrete consumers need them — this is not a generic free-form bag.
   */
  readonly describe?: () => PluginDescription;
  setup(context: PluginContext): void | ExtensionCleanup | Promise<void | ExtensionCleanup>;
}

/**
 * Which config file a plugin-contributed command requires. The CLI bootstrap
 * resolves the config path from this discriminant — the command descriptor
 * itself carries no path or config module reference.
 */
export type CommandConfigType = 'app' | 'migration' | 'runtime' | 'seed' | 'none';

/**
 * A pure, lazy command descriptor contributed by a plugin through its static
 * {@link PluginDescription}. The descriptor carries metadata only — the real
 * {@link CliCommand} is resolved on demand via `load()`, so the CLI can list
 * and validate commands without importing plugin code.
 */
export interface CommandContribution {
  /** Unique command name matching {@link COMMAND_NAME_PATTERN}. */
  readonly name: string;
  /** One-line description shown in help output; must be non-empty. */
  readonly summary: string;
  /** Optional usage string; carried through verbatim. */
  readonly usage?: string;
  /** Which users this command targets. */
  readonly audience: CommandAudience;
  /** Which config file the command needs, or `none` when it needs none. */
  readonly config: CommandConfigType;
  /** Lazy thunk that resolves the real command on demand; never called at index-build time. */
  readonly load: () => Promise<CliCommand>;
}

/**
 * Declarative metadata a plugin exposes through {@link JsailsPlugin.describe}.
 * Each field is populated only when the plugin owns that kind of metadata;
 * a consumer merges results from every plugin that returns a description.
 */
export interface PluginDescription {
  /** Server components registered by this plugin. */
  readonly components?: readonly {
    readonly name: string;
    readonly actions: readonly string[];
    readonly writableKeys: readonly string[];
  }[];
  /**
   * CSS custom properties this plugin contributes to the shared theme.
   * Inert declarative metadata — never resolved at import time. Collected
   * by the extension runner and fed to {@link themePlugin}.
   */
  readonly theme?: {
    readonly tokens: Readonly<Record<string, string>>;
  };
  /** CLI commands registered by this plugin (lazy — `load` is never called by the descriptor reader). */
  readonly commands?: readonly CommandContribution[];
}

/**
 * Identity helper for a plugin literal. Typing the parameter as
 * {@link JsailsPlugin} (rather than a `const` generic) keeps the plugin's
 * `setup` contextually typed as {@link PluginContext} even when the literal is
 * nested inside a `JsailsExtension[]` — e.g. `runExtensions([definePlugin({...})])`
 * or `config.extensions` — where an outer `JsailsExtension` context would
 * otherwise widen the parameter to {@link ExtensionContext} and hide
 * `intercept`/`observe`. Structural validation still happens later in
 * `runExtensions` / the config resolver, matching `defineDeploymentGenerator`'s
 * "validate later" contract.
 */
export function definePlugin(plugin: JsailsPlugin): JsailsPlugin {
  return plugin;
}
