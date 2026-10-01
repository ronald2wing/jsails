/**
 * Jamal image prune planner: determines which image refs to remove, keeping
 * the N most recent per service group.
 *
 * This is a pure planner: it performs no Docker operations, no remote calls,
 * and nothing is deleted. The returned list is deterministic for the same
 * inputs.
 */

/** An image ref (e.g. `ghcr.io/acme/myapp:abc123`). */
export type ImageRef = string;

/** The scope of a prune execution: all, images, or containers. */
export type PruneScope = 'all' | 'images' | 'containers';

/** Input for the prune planner: a retention count and the image list. */
export interface PruneInput {
  /** Number of most recent images to keep per service (must be >= 1). */
  readonly keep: number;
  /** Images discovered on the host, newest first. */
  readonly images: readonly ImageRef[];
}

/** The planned prune: which images to remove, grouped by service. */
export interface PrunePlan {
  /** Image refs to remove, newest first within each service group. */
  readonly toRemove: readonly ImageRef[];
  /** Image refs kept, newest first. */
  readonly kept: readonly ImageRef[];
}

/**
 * Raised for an invalid prune invocation (e.g. `keep < 1`). Messages are
 * value-free.
 */
export class JamalPruneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JamalPruneError';
  }
}

/** Extract the service name from an image ref (the part before the colon). */
function serviceName(ref: ImageRef): string {
  const colon = ref.lastIndexOf(':');
  return colon === -1 ? ref : ref.slice(0, colon);
}

/**
 * Plan which images to remove: group every image by its service name (the
 * repository without the tag), keep the first `keep` in each group (the
 * caller passes images newest first), and return the rest as `toRemove`.
 *
 * The removal list is deterministic: every image after the first `keep` in
 * its service group, newest first within that group. Images with no colon
 * (no tag) are grouped by the raw ref.
 *
 * Throws {@link JamalPruneError} when `keep < 1`.
 */
export function planPrune(input: PruneInput): PrunePlan {
  if (input.keep < 1) {
    throw new JamalPruneError(
      'keep must be at least 1; pass a positive number of recent images to retain',
    );
  }

  const groups = new Map<string, ImageRef[]>();
  for (const ref of input.images) {
    const svc = serviceName(ref);
    const list = groups.get(svc);
    if (list === undefined) {
      groups.set(svc, [ref]);
    } else {
      list.push(ref);
    }
  }

  const toRemove: ImageRef[] = [];
  const kept: ImageRef[] = [];

  for (const refs of groups.values()) {
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i] as ImageRef;
      if (i < input.keep) {
        kept.push(ref);
      } else {
        toRemove.push(ref);
      }
    }
  }

  return { toRemove, kept };
}

/**
 * Format the prune plan as human-readable output.
 */
export function formatPrunePlan(plan: PrunePlan): string {
  const lines: string[] = [];
  if (plan.toRemove.length === 0) {
    lines.push('No images to prune.', '');
    lines.push(`Kept ${plan.kept.length} image(s):`);
    for (const ref of plan.kept) {
      lines.push(`  ${ref}`);
    }
    return lines.join('\n');
  }
  lines.push(`${plan.toRemove.length} image(s) to remove:`, '');
  for (const ref of plan.toRemove) {
    lines.push(`  ${ref}`);
  }
  lines.push('');
  lines.push(`Kept ${plan.kept.length} image(s).`);
  return lines.join('\n');
}

/** Input for a prune execution plan: scope, retention hours, and ssh server. */
export interface PruneExecutionInput {
  /** What to prune: images, containers, or everything. */
  readonly scope: PruneScope;
  /** Hours of images to retain (>= 1). Only meaningful for `images` scope. */
  readonly retain: number;
  /** SSH target server (validated as a safe ssh token). */
  readonly server: string;
}

/** A planned prune execution: an argv array ready for the process runner. */
export interface PruneExecutionPlan {
  /** The `ssh <server> docker ... prune ...` argv (never executed by the planner). */
  readonly argv: readonly string[];
  /** The scope the argv was built for. */
  readonly scope: PruneScope;
  /** The retention value used. */
  readonly retain: number;
}

/** Control characters plus DEL — never valid in a server name. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/** Reject a server that cannot be a safe ssh target, value-free. */
function assertPruneServer(server: string): void {
  if (typeof server !== 'string' || server.length === 0) {
    throw new JamalPruneError('the ssh server must be a non-empty string');
  }
  if (/\s/.test(server) || CONTROL_CHARS.test(server)) {
    throw new JamalPruneError('the ssh server must not contain whitespace or control characters');
  }
  if (server.startsWith('-')) {
    throw new JamalPruneError('the ssh server must not start with "-"');
  }
}

/**
 * Build an `ssh <server> docker ... prune ...` argv array for the given scope
 * and retention. The server is validated as a safe ssh token (no whitespace,
 * control characters, or leading `-`); the plan is never executed — the caller
 * owns process creation.
 *
 * - `images` → `docker image prune -a --force --filter until=<retain>h`
 * - `containers` → `docker container prune --force`
 * - `all` → `docker system prune -a --force`
 *
 * Throws {@link JamalPruneError} when `retain < 1` or the server is invalid.
 */
export function planPruneExecution(input: PruneExecutionInput): PruneExecutionPlan {
  if (input.retain < 1) {
    throw new JamalPruneError(
      'retain must be at least 1; pass a positive number of hours to retain images',
    );
  }

  assertPruneServer(input.server);

  const { scope, retain, server } = input;
  const argv: string[] = ['ssh', server, 'docker'];

  if (scope === 'images') {
    argv.push('image', 'prune', '-a', '--force', '--filter', `until=${retain}h`);
  } else if (scope === 'containers') {
    argv.push('container', 'prune', '--force');
  } else {
    argv.push('system', 'prune', '-a', '--force');
  }

  return { argv, scope, retain };
}
