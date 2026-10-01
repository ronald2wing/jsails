/**
 * Jamal production deployment planner.
 *
 * {@link planProduction} turns a normalized {@link JamalConfig} plus a target
 * image tag into a {@link ProductionPlan}: a value-free, deterministic data
 * layout of the ordered deploy flow — build and push locally, then pull, run,
 * health-check, switch, and stop on the remote server, with an optional
 * rollback step — that a later executor slice materializes as real commands.
 * It is pure: it reads only its arguments, writes no file, reads no environment
 * variable, and its output is deterministic (stable ordering, no timestamps,
 * no clock or network access).
 *
 * The flow mirrors Kamal's deploy sequence:
 *
 *   1. `build`   — `docker buildx build` locally.
 *   2. `push`    — `docker push` locally.
 *   3. `pull`    — `ssh <server> docker pull`.
 *   4. `run`     — `ssh <server> docker run` the new container.
 *   5. `health`  — poll the health URL over SSH until it responds.
 *   6. `switch`  — when a production domain or an on-demand TLS URL is set, the
 *                  `kamal-proxy deploy` argv (assembled by {@link proxyDeployArgv}
 *                  and prefixed with `ssh <server>`); otherwise a description-only
 *                  directive.
 *   7. `stop`    — `ssh <server> docker stop` the previous container.
 *   8. `rollback` — only when `previousTag` is given; re-runs the previous
 *                  image so a failed cutover can be reverted.
 *
 * Backing services (`config.services`) prepend a set of `accessory` steps — a
 * data-volume creation, a container start, and a health poll per service —
 * before the build step, and their loopback env refs (`DATABASE_*`,
 * `VALKEY_URL`) are appended to the app `run` argv so the app reaches them.
 *
 * No secret value ever reaches the plan. `config.env` is reduced to
 * `{ name, secret }` entries — a {@link SecretRef} contributes only its NAME,
 * and a literal value is dropped entirely — and nothing else (image reference,
 * container name, health URL, argv, descriptions, warnings) embeds a resolved
 * value. Because the plan is already value-free, a `redactProductionPlan`
 * pass would be a no-op and is deliberately not provided.
 */

import {
  JamalConfigError,
  SecretRef,
  type JamalConfig,
  type JamalHealthConfig,
} from '../config.js';
import { planAccessories, type AccessoryStep } from './accessories.js';
import { proxyDeployArgv } from './proxy.js';

/** Control characters plus DEL — never valid in a tag. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/** Fallback fragment when a tag sanitizes to nothing but punctuation. */
const EMPTY_TAG_FRAGMENT = '0';

/** Maximum length of the sanitized tag fragment in the container name. */
const TAG_FRAGMENT_LENGTH = 12;

/** Health path used when `config.health` is absent (matches the app's `/up` default). */
const DEFAULT_HEALTH_PATH = '/up';

/** Per-probe timeout default when `config.health` is absent. */
const DEFAULT_TIMEOUT_MS = 5000;

/** Poll interval default when `config.health` is absent. */
const DEFAULT_INTERVAL_MS = 30000;

/** One ordered remote/local command in the deploy flow. */
export type ProductionStepKind =
  'build' | 'push' | 'pull' | 'run' | 'health' | 'switch' | 'stop' | 'rollback' | 'accessory';

/** A single step: its kind, a human description, and an optional fixed argv array. */
export interface ProductionStep {
  readonly kind: ProductionStepKind;
  readonly description: string;
  /** Fixed argv as data (never shell-interpolated); absent for pure directives. */
  readonly argv?: readonly string[];
  /** Structured metadata for an accessory step; absent for app steps. */
  readonly accessory?: AccessoryStep;
}

/** A `config.env` entry reduced to its name, secret flag, optional alias, and clear flag. */
export interface ProductionEnvEntry {
  readonly name: string;
  readonly secret: boolean;
  readonly alias: string | undefined;
  readonly clear: boolean;
}

/** A `config.volumes` entry: volume name, source/path/options, and host flag. */
export interface ProductionVolumeEntry {
  readonly name: string;
  readonly source: string;
  readonly containerPath: string;
  readonly options: string | undefined;
  readonly host: boolean;
}

/** Options for {@link planProduction}. */
export interface PlanProductionOptions {
  /** The image tag to deploy (validated: no whitespace or control characters). */
  readonly imageTag: string;
  /** The previously deployed tag, when rolling forward; enables `stop`/`rollback`. */
  readonly previousTag?: string;
}

/** The deterministic, value-free production plan. */
export interface ProductionPlan {
  /** `<config.image>:<tag>` — the full image reference to build, push, and run. */
  readonly imageRef: string;
  /** `<service>-web-<12-char sanitized tag>` — the new container name. */
  readonly containerName: string;
  /** The URL the health step polls; never includes registry or secret values. */
  readonly healthUrl: string;
  /** `config.health.timeoutMs` (defaults applied); the per-probe health timeout. */
  readonly healthTimeoutMs: number;
  /** `config.health.intervalMs` (defaults applied); the health poll interval. */
  readonly healthIntervalMs: number;
  /** `config.env` reduced to names plus a secret flag; never a value. */
  readonly env: readonly ProductionEnvEntry[];
  /** `config.volumes` as `{ name, containerPath }`, sorted by name. */
  readonly volumes: readonly ProductionVolumeEntry[];
  /** The ordered deploy flow as data. */
  readonly steps: readonly ProductionStep[];
  /** `config.health.retries` (undefined when unset); the executor applies its default. */
  readonly healthRetries: number | undefined;
  /** `config.health.retryDelayMs` (undefined when unset); the executor applies its default. */
  readonly healthRetryDelayMs: number | undefined;
  /** `config.health.readinessDelayMs` (undefined when unset); slept once before the first probe. */
  readonly healthReadinessDelayMs: number | undefined;
  /** Deterministic reminders (registry login, version skew); never a secret. */
  readonly warnings: readonly string[];
}

/** Reject a tag that is empty or carries whitespace/control characters, value-free. */
function assertImageTag(tag: string): void {
  if (typeof tag !== 'string' || tag.length === 0) {
    throw new JamalConfigError('the image tag must be a non-empty string');
  }
  if (CONTROL_CHARS.test(tag) || /\s/.test(tag)) {
    throw new JamalConfigError('the image tag must not contain whitespace or control characters');
  }
}

/**
 * Reject a production domain that cannot be a safe proxy `--host` value. The
 * domain becomes a proxy deploy argv token when the switch step is assembled,
 * so it must satisfy the same rules as every other proxy value (non-empty, no
 * whitespace or control characters, no leading `-`).
 */
function assertProxyHost(host: string): void {
  if (typeof host !== 'string' || host.length === 0) {
    throw new JamalConfigError('config.production.domain must be a non-empty string');
  }
  if (CONTROL_CHARS.test(host) || /\s/.test(host)) {
    throw new JamalConfigError(
      'config.production.domain must not contain whitespace or control characters',
    );
  }
  if (host.startsWith('-')) {
    throw new JamalConfigError('config.production.domain must not start with "-"');
  }
}

/**
 * Derive a deterministic, at-most-12-character alphanumeric fragment from a tag.
 * The tag is lowercased and every non-alphanumeric character is removed; a tag
 * that reduces to nothing (all punctuation) falls back to a fixed fragment so
 * the container name stays a valid, non-empty identifier.
 */
function containerTagFragment(tag: string): string {
  const alphanumeric = tag.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (alphanumeric === '' ? EMPTY_TAG_FRAGMENT : alphanumeric).slice(0, TAG_FRAGMENT_LENGTH);
}

/** Build --log-driver / --log-opt flags from config.logging, sorted by option key. */
function logDriverFlags(config: JamalConfig): readonly string[] {
  const logging = config.logging;
  if (logging === undefined) return [];
  const flags: string[] = ['--log-driver', logging.driver];
  const sorted = Object.entries(logging.options).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, value] of sorted) {
    flags.push('--log-opt', `${key}=${value}`);
  }
  return flags;
}

/**
 * The deterministic container name for a service at a tag. Exported so the
 * remote inspection verbs (`jamal logs`/`status`/`exec`) can reconstruct the
 * container a deploy left behind from the recorded history entry.
 */
export function containerNameForTag(service: string, tag: string): string {
  return `${service}-web-${containerTagFragment(tag)}`;
}

/**
 * Plan the production deployment for `config` at `options.imageTag`.
 *
 * `config.production` is required — the remote server (and optional domain)
 * name the SSH target and the health URL. Both `imageTag` and `previousTag`
 * (when given) are validated value-free. The result is pure and deterministic:
 * same input, same deep-equal plan, with stable key and step ordering and no
 * timestamps.
 */
export function planProduction(
  config: JamalConfig,
  options: PlanProductionOptions,
): ProductionPlan {
  const production = config.production;
  if (production === undefined) {
    throw new JamalConfigError('config.production is required to plan a production deployment');
  }
  assertImageTag(options.imageTag);
  const previousTag = options.previousTag;
  if (previousTag !== undefined) {
    assertImageTag(previousTag);
  }

  const { server, domain, onDemandTlsUrl, registry } = production;
  if (domain !== undefined) {
    assertProxyHost(domain);
  }
  const imageRef = `${config.image}:${options.imageTag}`;
  const containerName = containerNameForTag(config.service, options.imageTag);
  const previousImageRef = previousTag === undefined ? undefined : `${config.image}:${previousTag}`;
  const previousContainerName =
    previousTag === undefined
      ? undefined
      : `${config.service}-web-${containerTagFragment(previousTag)}`;

  const health: JamalHealthConfig = config.health ?? {
    path: DEFAULT_HEALTH_PATH,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    intervalMs: DEFAULT_INTERVAL_MS,
    retries: undefined,
    retryDelayMs: undefined,
    readinessDelayMs: undefined,
  };
  // A domain implies a TLS terminator, so the health probe is https; a bare
  // server has no certificate, so it is plain http. Registry/secret values
  // never enter the URL.
  const healthHost = domain ?? server;
  const healthUrl = `${domain === undefined ? 'http' : 'https'}://${healthHost}${health.path}`;
  const maxTimeSeconds = Math.max(1, Math.ceil(health.timeoutMs / 1000));

  // Backing services are provisioned before the app image is built, so the app
  // can start against a live database/Valkey. The env refs point the app at
  // loopback, where the accessory containers publish.
  const accessoryPlan = planAccessories(config);
  const appEnvFlags = accessoryPlan.appEnv.flatMap((entry) => [
    '-e',
    `${entry.name}=${entry.value}`,
  ]);

  const volumes = Object.entries(config.volumes)
    .map(([name, spec]) => ({
      name,
      source: spec.source,
      containerPath: spec.containerPath,
      options: spec.options,
      host: spec.host,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // Host volumes become -v flags on the run step.
  const hostVolumeFlags = volumes
    .filter((v) => v.host)
    .flatMap((v) => {
      const spec = v.options
        ? `${v.source}:${v.containerPath}:${v.options}`
        : `${v.source}:${v.containerPath}`;
      return ['-v', spec];
    });

  const steps: ProductionStep[] = [
    ...accessoryPlan.steps,
    {
      kind: 'build',
      description: `Build ${imageRef} locally with docker buildx.`,
      argv: ['docker', 'buildx', 'build', '-t', imageRef, '.'],
    },
    {
      kind: 'push',
      description: `Push ${imageRef} to the registry.`,
      argv: ['docker', 'push', imageRef],
    },
    {
      kind: 'pull',
      description: `Pull ${imageRef} on ${server}.`,
      argv: ['ssh', server, 'docker', 'pull', imageRef],
    },
    {
      kind: 'run',
      description: `Start ${containerName} from ${imageRef} on ${server}.`,
      argv: [
        'ssh',
        server,
        'docker',
        'run',
        '-d',
        '--name',
        containerName,
        ...appEnvFlags,
        ...hostVolumeFlags,
        ...logDriverFlags(config),
        imageRef,
      ],
    },
    {
      kind: 'health',
      description: `Poll ${healthUrl} every ${health.intervalMs} ms (${health.timeoutMs} ms per-probe timeout) until it responds.`,
      argv: ['ssh', server, 'curl', '-fsS', '--max-time', String(maxTimeSeconds), healthUrl],
    },
    {
      kind: 'switch',
      description: `Switch the proxy to route traffic to ${containerName}.`,
      // A domain implies a TLS-terminating proxy routing one static host, so the
      // switch step carries the real `kamal-proxy deploy` argv (ssh-prefixed)
      // with `--host <domain> --tls`. On-demand TLS replaces the static host
      // with an allowlist URL (still TLS-terminated). With neither, there is no
      // proxy host to route and the step stays a description-only directive.
      argv:
        domain !== undefined
          ? [
              'ssh',
              server,
              ...proxyDeployArgv({
                service: config.service,
                target: containerName,
                host: domain,
                tls: true,
              }),
            ]
          : onDemandTlsUrl !== undefined
            ? [
                'ssh',
                server,
                ...proxyDeployArgv({
                  service: config.service,
                  target: containerName,
                  onDemandTlsUrl,
                  tls: true,
                }),
              ]
            : undefined,
    },
    previousContainerName === undefined
      ? {
          kind: 'stop',
          description: `Stop the previous container on ${server}.`,
        }
      : {
          kind: 'stop',
          description: `Stop the previous container ${previousContainerName} on ${server}.`,
          argv: ['ssh', server, 'docker', 'stop', previousContainerName],
        },
  ];

  if (
    previousTag !== undefined &&
    previousImageRef !== undefined &&
    previousContainerName !== undefined
  ) {
    steps.push({
      kind: 'rollback',
      description: `Roll back to the previous release ${previousImageRef}.`,
      argv: [
        'ssh',
        server,
        'docker',
        'run',
        '-d',
        '--name',
        previousContainerName,
        previousImageRef,
      ],
    });
  }

  const env = Object.entries(config.env)
    .map(([name, entry]) => ({
      name,
      secret: entry.value instanceof SecretRef,
      alias: entry.alias,
      clear: entry.clear,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const warnings: string[] = [];
  if (registry !== undefined) {
    warnings.push(`Log in to the registry before pushing: docker login ${registry.server}.`);
  }
  if (previousTag !== undefined) {
    warnings.push(
      `Rolling forward from ${previousImageRef} to ${imageRef}: run any pending migrations ` +
        `before the proxy switch and keep ${previousTag} and ${options.imageTag} compatible ` +
        `during the cutover.`,
    );
  }

  return {
    imageRef,
    containerName,
    healthUrl,
    healthTimeoutMs: health.timeoutMs,
    healthIntervalMs: health.intervalMs,
    healthRetries: health.retries,
    healthRetryDelayMs: health.retryDelayMs,
    healthReadinessDelayMs: health.readinessDelayMs,
    env,
    volumes,
    steps,
    warnings,
  };
}

/**
 * Render a {@link ProductionPlan} as a deterministic, plain-text preview for
 * `jamal deploy --dry-run` / `jamal rollback --dry-run`. Each step prints its
 * kind and human description, followed by its fixed argv (when the step carries
 * one) so the operator can see exactly what would run. Accessory steps (backing
 * services) come first, then the app release flow; no secret value appears
 * because the plan is already value-free.
 */
export function formatProductionPlan(plan: ProductionPlan): string {
  const lines: string[] = [`image: ${plan.imageRef}`, `container: ${plan.containerName}`, ''];
  for (const step of plan.steps) {
    lines.push(`${step.kind}: ${step.description}`);
    if (step.argv !== undefined) {
      lines.push(`  $ ${step.argv.join(' ')}`);
    }
  }
  if (plan.warnings.length > 0) {
    lines.push('');
    for (const warning of plan.warnings) {
      lines.push(`warning: ${warning}`);
    }
  }
  return lines.join('\n');
}
