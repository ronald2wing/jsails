/**
 * Extension runner: an ordered, declared setup phase over the service registry
 * plus a collected set of HTTP hooks.
 *
 * Extensions are plain objects, not classes and not registered globally. The
 * runner prevalidates them, runs setup in declaration order against a registrar,
 * checks each extension's requirements against services that earlier extensions
 * actually registered, collects HTTP hooks, seals the registrar, and hands back
 * a runtime whose `close()` runs cleanups in reverse and wipes the registry.
 *
 * Hono is referenced through `import type` only: the router itself is the
 * maintained library, not a bespoke middleware engine, and importing this
 * module never pulls HTTP or ORM code into the runtime.
 */

import type { Hono } from 'hono';

import type { CliCommand } from '../cli/commands.js';
import {
  createServiceRegistry,
  type ServiceRegistrar,
  type ServiceRegistry,
  type ServiceToken,
} from './services.js';

/**
 * A hook that augments the maintained Hono router. It is a plain callback, not
 * a custom middleware engine: the runner collects hooks during setup and the
 * server integration invokes them against the app.
 */
export type HttpExtensionHook = (app: Hono) => void | Promise<void>;

/** Teardown returned from `setup`, invoked in reverse order on shutdown. */
export type ExtensionCleanup = () => void | Promise<void>;

/** The write-side surface handed to an extension during `setup`. */
export interface ExtensionContext {
  /** Registrar for services this extension provides. */
  readonly services: ServiceRegistrar;
  /** Register an HTTP hook; only valid while `setup` is running. */
  configureHttp(hook: HttpExtensionHook): void;
}

/** A unit of extensibility. */
export interface JsailsExtension {
  /** Unique, non-empty name; duplicate names are rejected before setup runs. */
  readonly name: string;
  /**
   * Tokens this extension reads during setup. Each must already be registered
   * by an earlier declared extension, otherwise the run fails before `setup`.
   */
  readonly requires?: readonly ServiceToken<unknown>[];
  /**
   * CLI commands this extension contributes to the application command
   * namespace. They are metadata for the config loader and CLI integration
   * writer: {@link runExtensions} never validates, collects, or invokes them,
   * and the reference is pulled in through `import type`, so this module gains
   * no runtime CLI, queue, or ORM dependency.
   */
  readonly commands?: readonly CliCommand[];
  /**
   * Provide services and register hooks. May return a cleanup function (or a
   * promise of one) for resources acquired here.
   *
   * An extension that throws before returning its teardown owns the cleanup of
   * whatever it partially created: the runner cannot dispose of resources whose
   * handles it never received. Return the teardown as soon as the resources
   * exist so the runner can clean them up on a later failure.
   */
  setup(context: ExtensionContext): void | ExtensionCleanup | Promise<void | ExtensionCleanup>;
}

/** The live result of a successful {@link runExtensions} call. */
export interface ExtensionRuntime {
  /** Read-only services, sealed after setup and closed after `close()`. */
  readonly services: ServiceRegistry;
  /** HTTP hooks in setup registration order; never invoked by the runner. */
  readonly httpHooks: readonly HttpExtensionHook[];
  /** Reverse cleanup then clear; idempotent and safe for concurrent callers. */
  close(): Promise<void>;
}

interface CompletedExtension {
  readonly cleanup: ExtensionCleanup | undefined;
}

/**
 * Validate names, uniqueness, setup functions, and requirement shapes before
 * any registry is created or any setup runs, so malformed input has no side
 * effects.
 */
function validateExtensions(extensions: readonly JsailsExtension[]): void {
  const names = new Set<string>();
  for (const extension of extensions) {
    if (extension === null || typeof extension !== 'object') {
      throw new TypeError('extension must be an object');
    }
    const name: unknown = extension.name;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new TypeError('extension name must be a non-empty string');
    }
    if (names.has(name)) {
      throw new TypeError(`duplicate extension name "${name}"`);
    }
    names.add(name);
    if (typeof extension.setup !== 'function') {
      throw new TypeError(`extension "${name}" must define a setup function`);
    }
    if (extension.requires !== undefined) {
      if (!Array.isArray(extension.requires)) {
        throw new TypeError(`extension "${name}" requires must be an array of service tokens`);
      }
      for (const token of extension.requires) {
        const tokenName: unknown =
          token !== null && typeof token === 'object'
            ? (token as { name?: unknown }).name
            : undefined;
        if (typeof tokenName !== 'string' || tokenName.trim() === '') {
          throw new TypeError(`extension "${name}" requires an invalid service token`);
        }
      }
    }
  }
}

/** Run every cleanup in reverse, collecting failures instead of aborting. */
async function runCleanups(completed: readonly CompletedExtension[]): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const entry of [...completed].reverse()) {
    if (entry.cleanup === undefined) continue;
    try {
      await entry.cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

/** Keep the primary failure first, aggregating cleanup failures behind it. */
function combine(primary: unknown, cleanupErrors: readonly unknown[]): unknown {
  if (cleanupErrors.length === 0) return primary;
  return new AggregateError([primary, ...cleanupErrors], 'extension setup failed', {
    cause: primary,
  });
}

/**
 * Run extensions in declaration order and return their runtime. Setup writes to
 * a fresh registry; after all setups succeed the registrar is sealed. On
 * failure the already-completed extensions are cleaned up in reverse, the
 * registry is cleared whatever the cleanups do, and the primary error is thrown
 * (aggregated with any cleanup errors).
 */
export async function runExtensions(
  extensions: readonly JsailsExtension[],
): Promise<ExtensionRuntime> {
  validateExtensions(extensions);

  const controller = createServiceRegistry();
  const hooks: HttpExtensionHook[] = [];
  let acceptingHooks = true;

  const context: ExtensionContext = {
    services: controller.registrar,
    configureHttp(hook: HttpExtensionHook): void {
      if (!acceptingHooks) {
        throw new Error('http hooks can only be configured during extension setup');
      }
      if (typeof hook !== 'function') {
        throw new TypeError('http hook must be a function');
      }
      hooks.push(hook);
    },
  };

  const completed: CompletedExtension[] = [];

  try {
    for (const extension of extensions) {
      for (const token of extension.requires ?? []) {
        if (!controller.services.has(token)) {
          throw new Error(
            `extension "${extension.name}" requires service "${token.name}" which is not registered`,
          );
        }
      }
      const result = await extension.setup(context);
      completed.push({ cleanup: typeof result === 'function' ? result : undefined });
    }
  } catch (error) {
    acceptingHooks = false;
    const cleanupErrors = await runCleanups(completed);
    controller.clear();
    throw combine(error, cleanupErrors);
  }

  acceptingHooks = false;
  controller.seal();

  const httpHooks: readonly HttpExtensionHook[] = hooks.slice();

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      const cleanupErrors = await runCleanups(completed);
      controller.clear();
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      if (cleanupErrors.length > 1) {
        throw new AggregateError(cleanupErrors, 'extension cleanup failed');
      }
    })();
    return closing;
  };

  return { services: controller.services, httpHooks, close };
}
