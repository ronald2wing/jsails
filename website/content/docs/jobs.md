---
title: Jobs
order: 18
section: Operating
---

# Background Jobs

JSails ships a provider-neutral job runtime: you define a job with a Zod schema
and a typed handler, bind the registry to a transport adapter, and drive it with
the `work` and `schedule` commands. The built-in transport is BullMQ over
Valkey/Redis, but the runtime itself never assumes a backend — a custom adapter
needs no connection URL at all.

## Defining a job

`defineJob(schema, handler)` pairs a Zod schema with a typed handler, and
`createJobRegistry({...})` validates the map. Payloads are validated on dispatch
**and** on the worker, so a malformed payload is rejected at both ends of the
queue.

```js
// No import: projected globals in app code.
import { z } from 'zod';

const sendEmail = defineJob(
  z.object({ to: z.string(), subject: z.string() }),
  async (data, ctx) => {
    await ctx.log(`send to ${data.to}`);
  },
);

export const registry = createJobRegistry({ sendEmail });
```

## The runtime

`new JobsRuntimeImpl({ registry, adapter, queueName?, prefix?, concurrency? })`
binds the registry to a `JobsRuntimeAdapter` and owns job-level policy: payload
validation on enqueue and on processing, dispatch-option allowlisting, local
schedule validation, lazy and idempotent handles, and an idempotent `close`.

An adapter is `{ name, createProducer, createWorker, upsertSchedules? }`. When
`upsertSchedules` is absent, `runtime.upsertSchedules` throws an explicit
`JobsRuntimeError` instead of silently doing nothing. `validateJobsRuntimeAdapter`
checks an adapter's shape without invoking any factory.

`new BullMQAdapter({ redisUrl, onError?, queueFactory?, workerFactory? })` is
the built-in adapter and the default transport. A custom adapter needs **no
connection URL** — `JobsRuntimeImpl` never receives one.

## Configuring the runtime — `jsails.runtime.js`

The `work` and `schedule` commands load a compiled ESM config whose default
export carries the registry, an optional adapter, and the schedule list:

```js
// jsails.runtime.js  (default config for `work` / `schedule`)
import { z } from 'zod';
import { defineJob, createJobRegistry } from 'jsails';

const sendEmail = defineJob(
  z.object({ to: z.string(), subject: z.string() }),
  async (data, ctx) => {
    await ctx.log(`send to ${data.to}`);
  },
);

export default {
  registry: createJobRegistry({ sendEmail }),
  // `adapter` is optional. Omit it to use the built-in BullMQ adapter, which
  // then requires a Valkey/Redis URL (valkeyUrl config key, or VALKEY_URL in
  // the environment). Supply a custom JobsRuntimeAdapter to target another
  // backend with no URL at all.
  valkeyUrl: process.env.VALKEY_URL ?? 'redis://127.0.0.1:6379',
  schedules: [
    {
      id: 'digest',
      job: 'sendEmail',
      cron: '0 3 * * *',
      data: { to: 'ops@example.com', subject: 'digest' },
    },
  ],
  queueName: 'default',
  concurrency: 1,
  // extensions: [{ name: 'my-service', setup({ services }) { ... } }],
};
```

When `config.adapter` is present it is selected verbatim (identity preserved)
and no URL is read or validated. When it is absent, the URL is resolved
(`valkeyUrl` → `VALKEY_URL`, and it must be `redis://` or `rediss://`) and the
built-in `BullMQAdapter` is constructed from it — lazily, so no connection
opens at import.

`config.extensions` is an optional array of extension objects
(`{ name, setup({ services, configureHttp, configureMiddleware }) }`).
When declared, `work` and `schedule` run them through `runExtensions`, build a
`ServiceRegistry`, and open an ambient app scope (`withAppScope`) around every
processed job — handler and per-job middleware — so `facade()` calls resolve.
When `extensions` is absent or empty, no scope is opened and facades throw
`FacadeError('no_app_scope')` exactly as before. Extensions are closed on
teardown; the registry is borrowed by the runtime, never owned or closed by it.

## Schedules

Each schedule spec is `{ id, job, cron | everyMs, timezone?, data? }` — exactly
one of `cron` or `everyMs` — and is validated locally before any provider call.
Queue defaults are 3 attempts with exponential backoff (1000 ms); `MAX_ATTEMPTS`
is 25.

Scheduling is at-least-once. The runtime does not guarantee exactly-once
delivery, non-overlap, or catch-up, so make your handlers idempotent.

## Running jobs

```sh
jsails work --config jsails.runtime.js      # worker + schedule registration
jsails schedule --config jsails.runtime.js  # one-shot registration, then exit
```

`work` starts a worker and registers schedules; `schedule` performs a one-shot
registration and exits. Both drive the selected adapter through the same neutral
contract, not a separate built-in path.

`queue` is a **read-only** dashboard over the same runtime config. It builds the
neutral runtime, reads the queue's normalized metrics
(`waiting`/`active`/`completed`/`failed`/`delayed`) through the producer's
optional `readCounts` capability, and prints them. It never starts a worker,
registers schedules, or dispatches a job; a transport without a countable queue
fails with a value-free error rather than printing zeros.

```sh
jsails queue --config jsails.runtime.js
jsails queue --json --config jsails.runtime.js
```

## Metrics and failed jobs

`new InMemoryJobMetrics(options?)` builds an in-memory aggregator that measures
completed and failed jobs by name via `snapshot()` and can `reset()` on its own
cadence. `recordCompleted` and `recordFailed` are synchronous; errors carry only
the message, never a payload or stack trace.

`new InMemoryFailedJobStore(options?)` holds a bounded ring buffer of value-free
`FailedJobEntry` records. `retry(id, dispatch)` calls an injected dispatch
function and removes the entry on success; on failure the entry stays. Both are
pure in-memory data structures with no external service dependency.

## Job middleware, chaining, and batching

`jsails/jobs` provides three built-in composition patterns — middleware,
chaining, and batching — that run on top of the neutral job runtime. All three
are **worker-side only**: they compose around the handler after payload
validation, and dispatch options carry the control descriptors.

### Per-job middleware

`composeMiddleware` wraps the handler with `JobMiddleware` functions registered
per job name via `new JobsRuntimeImpl({ middleware: { [jobName]: [mw, ...] } })`.
Middleware runs in declared order outermost-first on the worker; `next()` is
callable at most once, and returning without `next()` short-circuits the chain.
Errors propagate as `JobMiddlewareError` (codes `invalid_middleware` /
`middleware_threw`).

```js
// No import: these are projected globals in app code (see conventions.md).

const loggingMiddleware = async (ctx, next) => {
  console.log(`starting ${ctx.name} (${ctx.jobId})`);
  await next();
  console.log(`finished ${ctx.name}`);
};

const runtime = new JobsRuntimeImpl({
  registry,
  adapter,
  middleware: { sendEmail: [loggingMiddleware] },
});
```

### Chaining

`createJobChain(runtime, steps)` builds a sequential pipeline: the
`chainMiddleware`, registered on every chained job, enqueues step N+1 only after
step N's handler succeeds. The chain descriptor rides in dispatch options under
the reserved `CHAIN_OPTION_KEY`. Chaining is at-least-once: a retried step
re-runs the handler and continues on success — handlers must be idempotent.
`JobChainError` (codes `empty_chain` / `invalid_step`) rejects a malformed chain.

```js
// No import: these are projected globals in app code (see conventions.md).

const runtime = new JobsRuntimeImpl({
  registry,
  adapter,
  middleware: { stepA: [chainMiddleware], stepB: [chainMiddleware], stepC: [chainMiddleware] },
});

const chain = createJobChain(runtime, [
  { job: 'stepA', data: { file: 'report.csv' } },
  { job: 'stepB', data: {} },
  { job: 'stepC', data: {} },
]);
await chain.dispatch();
```

### Batching

`createJobBatch(runtime, coordinator, items, callbacks?)` fans out N jobs, each
carrying a `BatchDescriptor` under the reserved `BATCH_OPTION_KEY`. The per-job
`createBatchMiddleware(coordinator)` records every item's outcome into an
**injectable** `BatchCoordinator`; when all items settle, `then` (all ok) /
`catch` (any failed) / `finally` (always) fire once, in that order. Recording
is idempotent per item index; settlement is single-fire; callback errors are
swallowed. `JobBatchError` (codes `empty_batch` / `invalid_item`) rejects a
malformed batch.

```js
// No import: these are projected globals in app code (see conventions.md).

const coordinator = new InMemoryBatchCoordinator();

const runtime = new JobsRuntimeImpl({
  registry,
  adapter,
  middleware: { processItem: [createBatchMiddleware(coordinator)] },
});

const batch = await createJobBatch(
  runtime,
  coordinator,
  [
    { job: 'processItem', data: { id: 1 } },
    { job: 'processItem', data: { id: 2 } },
  ],
  {
    then: (summary) => console.log('all done', summary),
    catch: (failed) => console.error('some failed', failed),
  },
);
```

The built-in coordinator is in-process. A deployment with separate producer and worker processes must supply a coordinator backed by shared storage, or callbacks will not fire.

## Task scheduling and overlap control

`jsails/jobs` provides a `ScheduleDefinition.overlap` option to prevent
concurrent runs of the same scheduled job. The overlap descriptor rides in the
scheduled job's dispatch options under the reserved `OVERLAP_OPTION_KEY`, and a
per-job middleware — `createOverlapMiddleware(mutex)` — gates execution behind
a mutex store.

The mutex store itself lives in `jsails/cache`. It is a separate contract from
`CacheStore`: a cache is pure data whose `set` always overwrites, while a mutex
needs an atomic "acquire only when absent" operation. Two stores ship:
`MemoryMutexStore` (single-process; in-memory `Map` with expiry) and
`ValkeyMutexStore` (multi-process via atomic `SET NX PX`).

```js
// No import: these are projected globals in app code (see conventions.md).

const mutex = new MemoryMutexStore();

const runtime = new JobsRuntimeImpl({
  registry,
  adapter,
  middleware: {
    digest: [createOverlapMiddleware(mutex)],
  },
  schedules: [{ id: 'digest', job: 'sendDigest', cron: '0 3 * * *', overlap: true }],
});

// Read-only schedule list — names and metadata only, never payloads or data.
const schedules = await runtime.listSchedules();

// Pause the named schedules (removes their repeatable jobs from the provider).
await runtime.pauseSchedules(['digest']);
```

Two limits are worth noting:

- Pause is non-durable by default. `pauseSchedules` removes the repeatable job, but the next `work` start re-registers every schedule from config through `upsertSchedules`, so a paused schedule resumes automatically on process restart. There is no separate `resumeSchedules` call — resume by re-calling `upsertSchedules`.
- The memory mutex works only within a single process. Competing workers each have their own in-memory map and cannot see each other's locks. Use `ValkeyMutexStore` for multi-process deployments.

## Next steps

- [Testing](/docs/testing) — the in-process `createTestApp` surface and the native
  `node:test` suite.
- [CLI](/docs/cli) — `work`, `schedule`, and `queue` commands.
