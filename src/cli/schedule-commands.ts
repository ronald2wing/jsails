/**
 * The `schedules` command: a read-only schedule dashboard. It loads the runtime
 * config (default `jsails.runtime.js`, the same module `work`/`schedule` use),
 * creates the neutral runtime, reads schedules through `runtime.listSchedules()`,
 * prints them, and closes the runtime.
 *
 * ```sh
 * jsails schedules                 # human-readable schedule list
 * jsails schedules --json          # machine-readable schedule list
 * jsails schedules --config jsails.runtime.js
 * ```
 *
 * The command never starts a worker, registers schedules, pauses anything, or
 * dispatches a job. A transport without schedule inspection fails with a
 * value-free error rather than printing an empty list.
 */

import { createJobsRuntime, JobsRuntimeError, type JobsRuntime } from '../jobs/runtime.js';
import {
  loadRuntimeConfigModule,
  validateRuntimeConfig,
  type ResolvedRuntimeConfig,
} from '../jobs/runtime-config.js';
import type { ScheduleInfo } from '../jobs/runtime.js';

/** Options for {@link runSchedulesCommand}. */
export interface SchedulesCommandOptions {
  /** Print a single JSON object instead of the human-readable block. */
  readonly json?: boolean;
}

/** Dependency seam for the `schedules` command; tests inject a fake runtime. */
export interface SchedulesDeps {
  /** Build the neutral runtime controller for a resolved runtime config. */
  createRuntime(config: ResolvedRuntimeConfig): JobsRuntime;
  /** Write one output line. */
  stdout(text: string): void;
}

const defaultSchedulesDeps: SchedulesDeps = {
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

/** Render the schedule list as output lines (one JSON line, or a label block). */
function renderScheduleLines(schedules: readonly ScheduleInfo[], asJson: boolean): string[] {
  if (asJson) {
    return [JSON.stringify({ schedules })];
  }
  if (schedules.length === 0) {
    return ['Schedules: (none)'];
  }
  const lines: string[] = ['Schedules:'];
  for (const s of schedules) {
    const parts: string[] = [];
    if (s.overlap) {
      parts.push(`  overlap: ${s.overlap.key} (${s.overlap.ttlMs}ms)`);
    }
    parts.push(`  ${s.id}  ${s.job}  ${s.repeat}`);
    if (s.nextRunAt !== undefined) {
      parts.push(`  next: ${new Date(s.nextRunAt).toISOString()}`);
    }
    // overlap renders above the main line so it pairs with the schedule it
    // belongs to, mirroring the two-level layout of the queue dashboard.
    lines.push(...parts);
  }
  return lines;
}

/**
 * Read and print the registered schedules, then close the runtime. Returns the
 * process exit code. Exported for tests: inject a fake runtime to exercise the
 * read / render / close lifecycle without a live Valkey/Redis.
 */
export async function runSchedulesCommand(
  configPath: string,
  options: SchedulesCommandOptions = {},
  deps: SchedulesDeps = defaultSchedulesDeps,
): Promise<number> {
  const config = await loadResolvedRuntimeConfig(configPath);
  const runtime = deps.createRuntime(config);
  try {
    // The neutral runtime always exposes `listSchedules`; a fake runtime may
    // omit it. Both the absence and an unsupported transport map to the same
    // capability failure.
    if (typeof runtime.listSchedules !== 'function') {
      throw new JobsRuntimeError('job adapter does not support listing schedules');
    }
    const schedules = await runtime.listSchedules();
    for (const line of renderScheduleLines(schedules, options.json === true)) {
      deps.stdout(line);
    }
  } finally {
    await runtime.close();
  }
  return 0;
}
