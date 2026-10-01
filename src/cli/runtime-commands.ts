/**
 * Runtime commands: `work` (run the job worker) and `schedule` (one-shot
 * schedule registration). Their config module defaults to `jsails.runtime.js`
 * and default-exports a runtime object (registry, Valkey URL, schedules, ...);
 * see `jobs/runtime-config.ts`. The CLI owns SIGINT/SIGTERM only while `work`
 * is running, and never leaks clients or listeners on startup failure.
 */

import { JobsRuntimeImpl, type JobsRuntime } from '../jobs/runtime.js';
import {
  loadRuntimeConfigModule,
  validateRuntimeConfig,
  type ResolvedRuntimeConfig,
} from '../jobs/runtime-config.js';
import { runExtensions } from '../extensions/extension.js';

import { waitForShutdownSignal, type ShutdownSignal } from './shutdown.js';

/**
 * Dependency seam for the runtime commands. Tests inject a fake controller so
 * no live Valkey/Redis is contacted; the default builds the neutral runtime
 * from the resolved config's selected adapter (built-in or custom, through the
 * same contract).
 */
export interface RuntimeDeps {
  /** Build the neutral runtime controller for a resolved runtime config. */
  createRuntime(config: ResolvedRuntimeConfig): JobsRuntime;
  /** Install SIGINT/SIGTERM handlers and resolve on the first signal. */
  waitForShutdown?(): ShutdownSignal;
}

const defaultRuntimeDeps: RuntimeDeps = {
  createRuntime: (config) =>
    new JobsRuntimeImpl({
      registry: config.registry,
      adapter: config.adapter,
      queueName: config.queueName,
      prefix: config.prefix,
      concurrency: config.concurrency,
      serviceRegistry: config.serviceRegistry,
    }),
  waitForShutdown: waitForShutdownSignal,
};

async function loadResolvedRuntimeConfig(configPath: string): Promise<ResolvedRuntimeConfig> {
  const raw = await loadRuntimeConfigModule(configPath);
  return validateRuntimeConfig(raw);
}

/**
 * One-shot `schedule`: register the configured schedules, then exit. The
 * runtime is created, used, and closed; no worker or signal handler is
 * involved. An empty schedule list registers nothing and never forces a
 * producer (the runtime creates handles lazily, so nothing connects).
 */
async function runScheduleCommand(configPath: string, deps: RuntimeDeps): Promise<number> {
  const config = await loadResolvedRuntimeConfig(configPath);
  const ext = config.extensions.length > 0 ? await runExtensions(config.extensions) : undefined;
  const runtime = deps.createRuntime({ ...config, serviceRegistry: ext?.services });
  try {
    if (config.schedules.length > 0) {
      await runtime.upsertSchedules(config.schedules);
    }
    console.log(
      `Registered ${config.schedules.length} schedule(s) for queue "${config.queueName}".`,
    );
  } finally {
    await runtime.close();
    if (ext !== undefined) {
      await ext.close();
    }
  }
  return 0;
}

/**
 * `work`: register any schedules, start the worker, and wait for a shutdown
 * signal. The CLI owns SIGINT/SIGTERM only while `work` is running. Every
 * owned resource (the runtime controller, its producer/worker handles, and the
 * signal listeners) is closed/disposed on both the shutdown path and the
 * startup-failure path.
 */
async function runWorkCommand(configPath: string, deps: RuntimeDeps): Promise<number> {
  const config = await loadResolvedRuntimeConfig(configPath);

  // Build extensions before installing signal listeners so any setup
  // error surfaces immediately, before the worker loop starts.
  const ext = config.extensions.length > 0 ? await runExtensions(config.extensions) : undefined;

  // Install signal listeners before starting the worker so a signal can
  // interrupt the worker's startup connection retries.
  const signal = (deps.waitForShutdown ?? waitForShutdownSignal)();

  let runtime: JobsRuntime | undefined;
  const errors: unknown[] = [];
  try {
    runtime = deps.createRuntime({ ...config, serviceRegistry: ext?.services });
    if (config.schedules.length > 0) {
      await runtime.upsertSchedules(config.schedules);
    }
    await runtime.startWorker();
    console.log(`Worker started for queue "${config.queueName}". Waiting for shutdown signal.`);
    await signal.promise;
  } finally {
    signal.dispose();
    if (runtime !== undefined) {
      await runtime.close().catch((e) => errors.push(e));
    }
    if (ext !== undefined) {
      await ext.close().catch((e) => errors.push(e));
    }
  }
  if (errors.length > 0) {
    throw errors[0];
  }
  return 0;
}

/**
 * Dispatch a runtime command (`work` / `schedule`) with the given dependencies.
 * Exported for tests: inject a fake controller to exercise lifecycle, close
 * ordering, and registration without a live Valkey.
 */
export async function runRuntimeCommand(
  command: 'work' | 'schedule',
  configPath: string,
  deps: RuntimeDeps = defaultRuntimeDeps,
): Promise<number> {
  if (command === 'schedule') {
    return runScheduleCommand(configPath, deps);
  }
  return runWorkCommand(configPath, deps);
}
