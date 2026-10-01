/**
 * Jamal registry planner: builds a `docker login` argv from the production
 * registry config, with the password as a {@link SecretRef} name only.
 *
 * This is a pure planner: it returns an argv array and never runs Docker,
 * resolves secrets, or opens a connection. The returned password placeholder
 * is `secret(<name>)` — exactly the redacted form — so the command output
 * never embeds a real credential.
 */

import type { JamalConfig, JamalRegistryConfig } from './config.js';

/** Planned docker login argv for the configured registry. */
export interface RegistryLoginPlan {
  /** Fixed `docker login <server> -u <username> -p secret(<name>)` argv. */
  readonly argv: readonly string[];
  readonly server: string;
  readonly username: string;
  /** Secret name only (never the resolved value). */
  readonly passwordRef: string;
}

/**
 * Build a `docker login` argv from the production registry in `config`.
 * The password is the redacted `secret(<name>)` form; the caller must resolve
 * the actual secret before running the command.
 *
 * Throws {@link JamalError} when the config has no production registry
 * (value-free, never embedding config values).
 */
function requireRegistry(config: JamalConfig): JamalRegistryConfig {
  const registry = config.production?.registry;
  if (registry === undefined) {
    throw new JamalError(
      'a production registry is required; ' + 'set config.production.registry in jamal.config.js',
    );
  }
  return registry;
}

export function planRegistryLogin(config: JamalConfig): RegistryLoginPlan {
  const registry = requireRegistry(config);
  const passwordRef = `secret(JSAILS_REGISTRY_PASSWORD)`;
  return {
    argv: ['docker', 'login', registry.server, '-u', registry.username, '-p', passwordRef],
    server: registry.server,
    username: registry.username,
    passwordRef,
  };
}

/**
 * Alias of {@link planRegistryLogin} — a registry must exist before any
 * other operation, so `setup` emits the same `docker login` argv.
 */
export function planRegistrySetup(config: JamalConfig): RegistryLoginPlan {
  return planRegistryLogin(config);
}

/**
 * Build a `docker logout` argv for the configured registry server.
 * No password token appears in the argv — `docker logout` uses only the
 * server address and the caller's existing credentials.
 */
export function planRegistryRemove(config: JamalConfig): RegistryLoginPlan {
  const registry = requireRegistry(config);
  return {
    argv: ['docker', 'logout', registry.server],
    server: registry.server,
    username: registry.username,
    passwordRef: `secret(JSAILS_REGISTRY_PASSWORD)`,
  };
}

/**
 * Same as {@link planRegistryRemove} — `docker logout <server>`.
 */
export function planRegistryLogout(config: JamalConfig): RegistryLoginPlan {
  return planRegistryRemove(config);
}

/** Raised for invalid registry or prune/audit/snapshot invocations. */
class JamalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JamalError';
  }
}

export { JamalError };

/**
 * Format the login plan as human-readable output lines (each line a new entry).
 * The password is always the redacted form.
 */
export function formatRegistryLoginPlan(plan: RegistryLoginPlan): string {
  return [
    `Registry: ${plan.server}`,
    `Username: ${plan.username}`,
    `Password: ${plan.passwordRef}  (resolve this secret before running)`,
    '',
    `Command:`,
    `  ${plan.argv.join(' ')}`,
  ].join('\n');
}
