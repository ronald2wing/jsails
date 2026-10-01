---
title: Background Jobs
order: 10
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
import { z } from 'zod';
import { defineJob, createJobRegistry } from 'jsails';

const sendEmail = defineJob(
  z.object({ to: z.string(), subject: z.string() }),
  async (data, ctx) => { await ctx.log(`send to ${data.to}`); },
);

export const registry = createJobRegistry({ sendEmail });
```

## The runtime

`createJobsRuntime({ registry, adapter, queueName?, prefix?, concurrency? })`
binds the registry to a `JobsRuntimeAdapter` and owns job-level policy: payload
validation on enqueue and on processing, dispatch-option allowlisting, local
schedule validation, lazy and idempotent handles, and an idempotent `close`.

An adapter is `{ name, createProducer, createWorker, upsertSchedules? }`. When
`upsertSchedules` is absent, `runtime.upsertSchedules` throws an explicit
`JobsRuntimeError` instead of silently doing nothing. `validateJobsRuntimeAdapter`
checks an adapter's shape without invoking any factory.

`createBullMQAdapter({ redisUrl, onError?, queueFactory?, workerFactory? })` is
the built-in adapter and the default transport. A custom adapter needs **no
connection URL** — `createJobsRuntime` never receives one.

## Configuring the runtime — `jsails.runtime.js`

The `work` and `schedule` commands load a compiled ESM config whose default
export carries the registry, an optional adapter, and the schedule list:

```js
// jsails.runtime.js  (default config for `work` / `schedule`)
import { z } from 'zod';
import { defineJob, createJobRegistry } from 'jsails';

const sendEmail = defineJob(
  z.object({ to: z.string(), subject: z.string() }),
  async (data, ctx) => { await ctx.log(`send to ${data.to}`); },
);

export default {
  registry: createJobRegistry({ sendEmail }),
  // `adapter` is optional. Omit it to use the built-in BullMQ adapter, which
  // then requires a Valkey/Redis URL (valkeyUrl config key, or VALKEY_URL in
  // the environment). Supply a custom JobsRuntimeAdapter to target another
  // backend with no URL at all.
  valkeyUrl: process.env.VALKEY_URL ?? 'redis://127.0.0.1:6379',
  schedules: [{ id: 'digest', job: 'sendEmail', cron: '0 3 * * *',
                data: { to: 'ops@example.com', subject: 'digest' } }],
  queueName: 'default',
  concurrency: 1,
};
```

When `config.adapter` is present it is selected verbatim (identity preserved)
and no URL is read or validated. When it is absent, the URL is resolved
(`valkeyUrl` → `VALKEY_URL`, and it must be `redis://` or `rediss://`) and the
built-in `createBullMQAdapter` is constructed from it — lazily, so no connection
opens at import.

## Schedules

Each schedule spec is `{ id, job, cron | everyMs, timezone?, data? }` — exactly
one of `cron` or `everyMs` — and is validated locally before any provider call.
Queue defaults are 3 attempts with exponential backoff (1000 ms); `MAX_ATTEMPTS`
is 25.

Scheduling is **at-least-once**: there is no exactly-once, non-overlap, or
catch-up guarantee. Make handlers idempotent.

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

`createJobMetrics(options?)` builds an in-memory aggregator that measures
completed and failed jobs by name via `snapshot()` and can `reset()` on its own
cadence. `recordCompleted` and `recordFailed` are synchronous; errors carry only
the message, never a payload or stack trace.

`createFailedJobStore(options?)` holds a bounded ring buffer of value-free
`FailedJobEntry` records. `retry(id, dispatch)` calls an injected dispatch
function and removes the entry on success; on failure the entry stays. Both are
pure in-memory data structures with no external service dependency.

## Next steps

- [Services](/docs/services) — the extension seam, service tokens, and plugins.
