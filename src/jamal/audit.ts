/**
 * Jamal audit planner: produces a security checklist from the jamal config.
 *
 * This is a pure planner: it returns value-free descriptor strings and never
 * opens a connection, resolves secrets, or runs Docker. Every finding is a
 * plain-text recommendation; the caller decides which to act on.
 *
 * Findings are intentionally conservative: the planner flags common patterns
 * an operator should review, but it cannot know a deployment's threat model.
 * A finding is a suggestion, never a hard block.
 */

import type { JamalConfig } from './config.js';

/** One audit finding: a severity and a human-readable descriptor. */
export interface AuditFinding {
  /** `info` (advisory), `warning` (recommend action), or `error` (must fix). */
  readonly severity: 'info' | 'warning' | 'error';
  /** Value-free description of the finding. */
  readonly description: string;
}

/** The audit result: a list of findings plus a summary. */
export interface AuditPlan {
  readonly findings: readonly AuditFinding[];
  /** Summary line: total findings by severity. */
  readonly summary: string;
}

/** Raised for an invalid audit invocation. */
export class JamalAuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JamalAuditError';
  }
}

/**
 * Audit the jamal config and return every finding as a value-free descriptor.
 * The config is inspected structurally only; no secret is ever resolved or
 * echoed, and no environment variable is read.
 */
export function planAudit(config: JamalConfig): AuditPlan {
  const findings: AuditFinding[] = [];

  // 1. Missing production config entirely.
  if (config.production === undefined) {
    findings.push({
      severity: 'info',
      description:
        'No production config; the app deploys only locally. Add config.production to jamal.config.js when deploying.',
    });
  } else {
    // 2. Missing TLS configuration (no domain and no on-demand TLS URL).
    if (config.production.domain === undefined && config.production.onDemandTlsUrl === undefined) {
      findings.push({
        severity: 'warning',
        description:
          'No TLS configured: neither production.domain nor production.onDemandTlsUrl is set. ' +
          'A production deployment without TLS serves traffic in plaintext.',
      });
    }

    // 3. On-demand TLS without an allowlist endpoint means any hostname can get a cert.
    if (config.production.onDemandTlsUrl !== undefined) {
      findings.push({
        severity: 'warning',
        description:
          'On-demand TLS is enabled. The endpoint at the configured URL must return 200 only ' +
          'for hostnames you control; an over-permissive endpoint allows certificate issuance ' +
          'for unauthorized domains.',
      });
    }

    // 4. Missing registry for production.
    if (config.production.registry === undefined) {
      findings.push({
        severity: 'error',
        description:
          'No registry configured for production. A production deploy must have a registry to push and pull images.',
      });
    }
  }

  // 5. Plaintext env values (not using secret refs) — always checked.
  const plaintextEnvKeys: string[] = [];
  for (const [key, value] of Object.entries(config.env)) {
    // `config.env` is normalized to structured entries; a plaintext warning
    // applies when the entry's value is a literal string (a `SecretRef` names a
    // secret without embedding it, and `clear: true` marks an explicit literal).
    if (
      typeof value === 'string' ||
      (typeof value === 'object' &&
        value !== null &&
        typeof value.value === 'string' &&
        value.clear !== true)
    ) {
      plaintextEnvKeys.push(key);
    }
  }
  if (plaintextEnvKeys.length > 0) {
    findings.push({
      severity: 'warning',
      description:
        `${plaintextEnvKeys.length} env value(s) are plaintext strings rather than secret() references: ` +
        `${plaintextEnvKeys.join(', ')}. ` +
        'Plaintext values are committed to the config; use secret(<name>) references and resolve them at deploy time instead.',
    });
  }

  // 6. Health check configuration.
  if (config.health === undefined) {
    findings.push({
      severity: 'warning',
      description:
        'No health check configured. Without a health.path, the deploy engine cannot verify ' +
        'that a started container is healthy before switching traffic to it.',
    });
  } else {
    // Health check path should not be `/up` if behind a reverse proxy that strips it.
    if (config.health.path === '/up') {
      findings.push({
        severity: 'info',
        description:
          'Health check path is /up (the default). Ensure this path is not exposed publicly ' +
          'if it reveals internal state.',
      });
    }
  }

  // 7. Port exposure check: the local ports configuration shouldn't expose database ports on all interfaces.
  const exposedPorts = Object.entries(config.local.ports).filter(([, port]) => port > 0);
  if (exposedPorts.length > 0) {
    const portsDesc = exposedPorts.map(([name, port]) => `${name}:${port}`).join(', ');
    findings.push({
      severity: 'info',
      description:
        `Local ports published: ${portsDesc}. These are accessible from the Docker host. ` +
        'In production these ports are not published to the host.',
    });
  }

  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warnCount = findings.filter((f) => f.severity === 'warning').length;
  const infoCount = findings.filter((f) => f.severity === 'info').length;

  return {
    findings,
    summary: `${errorCount} error(s), ${warnCount} warning(s), ${infoCount} info(s)`,
  };
}

/**
 * Format the audit plan as human-readable output.
 */
export function formatAuditPlan(plan: AuditPlan): string {
  if (plan.findings.length === 0) {
    return 'No findings.';
  }
  const lines: string[] = [];
  const labels: Record<string, string> = { error: 'ERROR', warning: 'WARN ', info: 'INFO ' };
  for (const finding of plan.findings) {
    lines.push(`  [${labels[finding.severity]}] ${finding.description}`);
  }
  lines.push('');
  lines.push(plan.summary);
  return lines.join('\n');
}
