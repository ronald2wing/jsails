/**
 * The `queue` command: a read-only queue dashboard. It loads the runtime config
 * (default `jsails.runtime.js`, the same module `work`/`schedule` use), creates
 * the neutral job runtime, reads the queue's normalized metrics through the
 * producer's optional transport capability, prints them, and closes the runtime.
 *
 * ```sh
 * jsails queue                 # human-readable counts
 * jsails queue --json          # machine-readable counts
 * jsails queue --config jsails.runtime.js
 * ```
 *
 * The command never starts a worker, registers schedules, or dispatches a job;
 * it only reads counts. A transport without a countable queue fails with a
 * value-free error rather than printing zeros.
 */

import { createJobsRuntime, JobsRuntimeError, type JobsRuntime } from '../jobs/runtime.js';
import {
  loadRuntimeConfigModule,
  validateRuntimeConfig,
  type ResolvedRuntimeConfig,
} from '../jobs/runtime-config.js';
import type { QueueCounts } from '../jobs/runtime.js';

/** Options for {@link runQueueCommand}. */
export interface QueueCommandOptions {
  /** Print a single JSON object instead of the human-readable block. */
  readonly json?: boolean;
}

/** Dependency seam for the `queue` command; tests inject a fake runtime. */
export interface QueueDeps {
  /** Build the neutral runtime controller for a resolved runtime config. */
  createRuntime(config: ResolvedRuntimeConfig): JobsRuntime;
  /** Write one output line. */
  stdout(text: string): void;
}

const defaultQueueDeps: QueueDeps = {
  createRuntime: (config) =>
    createJobsRuntime({
      registry: config.registry,
      adapter: config.adapter,
      queueName: config.queueName,
      prefix: config.prefix,
      concurrency: config.concurrency,
    }),
  stdout: (text) => process.stdout.write(`${text}\n`),
};

async function loadResolvedRuntimeConfig(configPath: string): Promise<ResolvedRuntimeConfig> {
  const raw = await loadRuntimeConfigModule(configPath);
  return validateRuntimeConfig(raw);
}

/** Render the queue metrics as output lines (one JSON line, or a label block). */
function renderQueueLines(queueName: string, counts: QueueCounts, asJson: boolean): string[] {
  if (asJson) {
    return [JSON.stringify({ queue: queueName, ...counts })];
  }
  return [
    `Queue "${queueName}" counts:`,
    `  waiting:   ${counts.waiting}`,
    `  active:    ${counts.active}`,
    `  completed: ${counts.completed}`,
    `  failed:    ${counts.failed}`,
    `  delayed:   ${counts.delayed}`,
  ];
}

/**
 * Read and print the queue metrics, then close the runtime. Returns the process
 * exit code. Exported for tests: inject a fake runtime to exercise the read /
 * render / close lifecycle without a live Valkey/Redis.
 */
export async function runQueueCommand(
  configPath: string,
  options: QueueCommandOptions = {},
  deps: QueueDeps = defaultQueueDeps,
): Promise<number> {
  const config = await loadResolvedRuntimeConfig(configPath);
  const runtime = deps.createRuntime(config);
  try {
    // The neutral runtime always exposes `readCounts`; a fake runtime may omit
    // it. Both the absence and an unsupported transport map to the same
    // capability failure.
    if (typeof runtime.readCounts !== 'function') {
      throw new JobsRuntimeError('job adapter does not support queue metrics');
    }
    const counts = await runtime.readCounts();
    for (const line of renderQueueLines(config.queueName, counts, options.json === true)) {
      deps.stdout(line);
    }
  } finally {
    await runtime.close();
  }
  return 0;
}
