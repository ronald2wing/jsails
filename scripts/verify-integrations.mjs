/**
 * Opt-in live-integration verification harness.
 *
 * Exercises the framework's four external-service seams against *real* services
 * the operator has provisioned and pointed at via environment variables. This is
 * deliberately the opposite of the unit suite, which fakes every adapter: here a
 * MariaDB/Postgres server, a Valkey/Redis instance, and (optionally) a Docker
 * daemon are contacted for real, so a green run proves the wiring end to end.
 *
 * Every stage is env-gated and skips cleanly when its variables are absent, so
 * the default workflow (and `npm run check`) is never affected — running this
 * on a machine without those services simply reports four `skipped` stages and
 * exits 0. A stage that is *enabled* but then fails (unreachable service, bad
 * config, unexpected error) is a real failure and the process exits non-zero.
 *
 * Stages:
 *   (A) database   — JSAILS_TEST_DB_TYPE (mariadb|postgres) plus
 *                    JSAILS_TEST_DB_HOST/PORT/USER/PASSWORD/NAME. Builds a
 *                    temporary JsailsDataSource around one scalar EntitySchema,
 *                    generates a migration definition offline into an owned temp
 *                    migrations dir, runs `migrate`, performs Active Record
 *                    insert/query/update/delete with BaseEntity, reads
 *                    `getMigrationStatus`, then drops only its own tables and
 *                    destroys the connection. Credentials are never printed.
 *   (B) jobs        — JSAILS_TEST_VALKEY_URL. One echo job dispatched through
 *                    the BullMQ queue and consumed by a worker; the handler run
 *                    is asserted, one interval schedule is upserted, then
 *                    everything is closed. Bounded timeout.
 *   (C) broadcast   — JSAILS_TEST_VALKEY_URL. attachBroadcast onto a loopback
 *                    HTTP server with a Redis pub/sub URL, two clients connect,
 *                    message delivery is asserted and channel authorization is
 *                    asserted to deny an unauthorized subscription, then closed.
 *   (D) docker      — JSAILS_TEST_DOCKER=1. Runs `docker version` / `docker
 *                    info` read-only and reports available/unavailable. Never
 *                    builds images or starts containers.
 *
 * Output is a per-stage line plus a final tally (`SUMMARY ok=<n> failed=<n>
 * skipped=<n>`). Exit code is 0 unless a stage failed.
 *
 * This script uses the already-built `dist/`: it requires the build to exist
 * (printing a hint to run `npm run build`) and never builds anything itself. It
 * is opt-in — run it with `npm run verify:integrations`; no CLI command triggers
 * it and it is not part of `npm test` / `npm run check`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { EntitySchema } from 'typeorm';
import { z } from 'zod';
import { io as createClient } from 'socket.io-client';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST_INDEX = join(REPO_ROOT, 'dist', 'src', 'index.js');
const DIST_INDEX_URL = pathToFileURL(DIST_INDEX).href;

/** Bounded budgets per stage so a hung service surfaces as a failure, not a hang. */
const DATABASE_CONNECT_TIMEOUT_MS = 15_000;
const JOBS_TIMEOUT_MS = 20_000;
const BROADCAST_CONNECT_MS = 10_000;
const BROADCAST_ACK_MS = 10_000;
const BROADCAST_EVENT_MS = 10_000;
const DOCKER_TIMEOUT_MS = 15_000;

/** Broadcast protocol constants, mirrored from src/broadcast/server.ts. */
const BROADCAST_ORIGIN = 'https://verify.jsails.test';
const SUBSCRIBE_EVENT = 'jsails:subscribe';
const BROADCAST_EVENT = 'jsails:event';
/** Engine.IO path the built-in adapter mounts on (src/broadcast/contracts.ts). */
const BROADCAST_PATH = '/_jsails/broadcast';

const DB_TYPE_ENV = 'JSAILS_TEST_DB_TYPE';
const DB_HOST_ENV = 'JSAILS_TEST_DB_HOST';
const DB_PORT_ENV = 'JSAILS_TEST_DB_PORT';
const DB_USER_ENV = 'JSAILS_TEST_DB_USER';
const DB_PASSWORD_ENV = 'JSAILS_TEST_DB_PASSWORD';
const DB_NAME_ENV = 'JSAILS_TEST_DB_NAME';
const VALKEY_URL_ENV = 'JSAILS_TEST_VALKEY_URL';
const DOCKER_ENV = 'JSAILS_TEST_DOCKER';

/** The tracking table JSails' migration runner creates and owns. */
const RESERVED_MIGRATIONS_TABLE = 'jsails_migrations';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Classify a caught value into a one-line, value-free message. */
function describeError(error) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

/** Replace every non-empty secret with a fixed marker so credentials never leak. */
function redact(message, secrets) {
  let out = message;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) {
      out = out.split(secret).join('[redacted]');
    }
  }
  return out;
}

/** Reject after `ms`, so a service that never answers fails instead of hanging. */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Config-error thrown by stage setup; never carries raw input values. */
class VerifyConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VerifyConfigError';
  }
}

// ---------------------------------------------------------------------------
// Stage A: database migrations + Active Record CRUD
// ---------------------------------------------------------------------------

/**
 * Parse the database env block. Returns `null` when the stage is disabled (type
 * absent); otherwise validates every field and returns the connection settings.
 * Throws {@link VerifyConfigError} on a malformed block, never echoing a value.
 */
function readDatabaseConfig(env) {
  const type = env[DB_TYPE_ENV];
  if (type === undefined || type === '') {
    return null;
  }
  if (type !== 'mariadb' && type !== 'postgres') {
    throw new VerifyConfigError(`${DB_TYPE_ENV} must be one of "mariadb" or "postgres"`);
  }
  const host = env[DB_HOST_ENV];
  const user = env[DB_USER_ENV];
  const password = env[DB_PASSWORD_ENV];
  const name = env[DB_NAME_ENV];
  const portRaw = env[DB_PORT_ENV];

  const missing = [];
  if (!host) missing.push(DB_HOST_ENV);
  if (!user) missing.push(DB_USER_ENV);
  if (!password) missing.push(DB_PASSWORD_ENV);
  if (!name) missing.push(DB_NAME_ENV);
  const port = portRaw === undefined ? NaN : Number(portRaw);
  if (portRaw === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    missing.push(`${DB_PORT_ENV} (an integer between 1 and 65535)`);
  }
  if (missing.length > 0) {
    throw new VerifyConfigError(`database stage incomplete: ${missing.join(', ')}`);
  }
  return { type, host, port, user, password, name };
}

/** Read the JSON migration definitions in `dir` the same way the CLI does. */
function readMigrationHistory(dir) {
  const migrations = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.json')) continue;
    migrations.push(JSON.parse(readFileSync(join(dir, entry), 'utf8')));
  }
  return migrations;
}

async function runDatabaseStage(api, env) {
  let config;
  try {
    config = readDatabaseConfig(env);
  } catch (error) {
    return { stage: 'database', status: 'failed', detail: describeError(error) };
  }
  if (config === null) {
    return { stage: 'database', status: 'skipped', detail: `${DB_TYPE_ENV} is not set` };
  }

  const { type, host, port, user, password, name } = config;
  const secrets = [password, user];

  // One scalar entity, bound to a BaseEntity subclass so the Active Record
  // static methods resolve to this data source (TypeORM auto-binds it during
  // metadata construction).
  class VerifyWidget extends api.BaseEntity {}
  const widgetSchema = new EntitySchema({
    name: 'VerifyWidget',
    tableName: 'verify_widgets',
    target: VerifyWidget,
    columns: {
      id: { type: 'integer', primary: true, generated: true },
      label: { type: 'varchar', length: 100, nullable: false },
      active: { type: 'boolean', nullable: false, default: true },
    },
  });

  const dataSourceOptions = {
    type,
    host,
    port,
    username: user,
    password,
    database: name,
    entities: [widgetSchema],
  };
  // Bound the driver's connection attempt so an unreachable host fails rather
  // than hanging the stage on the OS TCP timeout.
  if (type === 'postgres') {
    dataSourceOptions.connectionTimeoutMillis = DATABASE_CONNECT_TIMEOUT_MS;
  } else {
    dataSourceOptions.connectTimeout = DATABASE_CONNECT_TIMEOUT_MS;
  }
  const dataSource = new api.JsailsDataSource(dataSourceOptions);

  const migrationsDir = mkdtempSync(join(tmpdir(), 'jsails-integrations-db-'));

  try {
    // Offline: build the model schema and diff it against the empty history.
    const desiredSchema = await dataSource.getModelSchema();
    const definition = api.generateMigration('create_verify_widgets', [], desiredSchema);
    if (definition === null) {
      throw new Error('no migration generated for a fresh schema');
    }
    writeFileSync(
      join(migrationsDir, 'create_verify_widgets.json'),
      `${JSON.stringify(definition, null, 2)}\n`,
    );
    const history = readMigrationHistory(migrationsDir);

    await dataSource.initialize();

    const applied = await api.migrate(dataSource, history);
    if (applied.applied.length !== 1) {
      throw new Error(`expected 1 applied migration, got ${applied.applied.length}`);
    }

    // Active Record CRUD through the BaseEntity subclass.
    const inserted = await VerifyWidget.insert({ label: 'alpha', active: true });
    const insertedId = inserted.identifiers[0]?.id;

    const found = await VerifyWidget.find();
    if (found.length !== 1 || found[0]?.label !== 'alpha') {
      throw new Error('Active Record query did not return the inserted row');
    }

    await VerifyWidget.update({ id: insertedId }, { label: 'beta' });
    const updated = await VerifyWidget.findOneBy({ id: insertedId });
    if (updated?.label !== 'beta') {
      throw new Error('Active Record update did not persist');
    }

    await VerifyWidget.delete({ id: insertedId });
    if ((await VerifyWidget.find()).length !== 0) {
      throw new Error('Active Record delete did not remove the row');
    }

    const status = await api.getMigrationStatus(dataSource, history);
    if (!status.tableExists || status.applied.length !== 1 || status.pending.length !== 0) {
      throw new Error('migration status is inconsistent after apply');
    }

    return {
      stage: 'database',
      status: 'ok',
      detail: `migrations + Active Record CRUD on ${type}`,
    };
  } catch (error) {
    return { stage: 'database', status: 'failed', detail: redact(describeError(error), secrets) };
  } finally {
    // Drop only the tables this run created: the entity table and JSails'
    // own tracking table. Never touch any other table in the database.
    if (dataSource.isInitialized) {
      await dataSource.query(`DROP TABLE IF EXISTS verify_widgets`).catch(() => {});
      await dataSource.query(`DROP TABLE IF EXISTS ${RESERVED_MIGRATIONS_TABLE}`).catch(() => {});
    }
    await dataSource.destroy().catch(() => {});
    rmSync(migrationsDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Stage B: jobs (queue + worker + schedule)
// ---------------------------------------------------------------------------

async function runJobsStage(api, env) {
  const rawUrl = env[VALKEY_URL_ENV];
  if (rawUrl === undefined || rawUrl === '') {
    return { stage: 'jobs', status: 'skipped', detail: `${VALKEY_URL_ENV} is not set` };
  }
  let url;
  try {
    url = api.assertRedisUrl(rawUrl);
  } catch (error) {
    return { stage: 'jobs', status: 'failed', detail: describeError(error) };
  }

  const prefix = `jsails-int-${process.pid}-${Date.now().toString(36)}`;
  const queueName = 'echo';

  let resolveRan;
  const ran = new Promise((resolve) => {
    resolveRan = resolve;
  });
  const registry = api.createJobRegistry({
    echo: api.defineJob(z.object({ value: z.string() }), async (data) => {
      if (data.value !== 'ping') {
        throw new Error(`unexpected payload`);
      }
      resolveRan();
    }),
  });

  const runtime = api.createJobsRuntime({
    registry,
    adapter: api.createBullMQAdapter({
      redisUrl: url,
      onError: (error) => {
        console.error(`[jsails:verify] jobs error: ${redact(describeError(error), [url])}`);
      },
    }),
    queueName,
    prefix,
  });

  let primaryError;
  try {
    await withTimeout(
      (async () => {
        await runtime.startWorker();
        await runtime.dispatch(
          'echo',
          { value: 'ping' },
          { removeOnComplete: true, removeOnFail: true },
        );
        await ran;
      })(),
      JOBS_TIMEOUT_MS,
      'echo job round-trip',
    );
    await runtime.upsertSchedules([
      { id: 'echo-interval', job: 'echo', everyMs: 60_000, data: { value: 'scheduled' } },
    ]);
  } catch (error) {
    primaryError = error;
  }

  await runtime.close().catch(() => {});

  if (primaryError !== undefined) {
    return {
      stage: 'jobs',
      status: 'failed',
      detail: redact(describeError(primaryError), [url]),
    };
  }
  return { stage: 'jobs', status: 'ok', detail: 'echo job dispatched, consumed, and scheduled' };
}

// ---------------------------------------------------------------------------
// Stage C: broadcast pub/sub
// ---------------------------------------------------------------------------

function listen(httpServer) {
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
}

function connectRaw(port, authorization) {
  const socket = createClient(`http://127.0.0.1:${port}`, {
    path: BROADCAST_PATH,
    transports: ['websocket'],
    reconnection: false,
    timeout: 2000,
    extraHeaders: { Origin: BROADCAST_ORIGIN, Authorization: authorization },
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('broadcast connect timed out'));
    }, BROADCAST_CONNECT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function subscribeRaw(socket, channels) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('subscribe ack timed out')), BROADCAST_ACK_MS);
    socket.emit(SUBSCRIBE_EVENT, { channels }, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function nextRawEvent(socket) {
  return new Promise((resolve, reject) => {
    const handler = (payload) => {
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      socket.off(BROADCAST_EVENT, handler);
      reject(new Error('broadcast event timed out'));
    }, BROADCAST_EVENT_MS);
    socket.on(BROADCAST_EVENT, handler);
  });
}

async function runBroadcastStage(api, env) {
  const rawUrl = env[VALKEY_URL_ENV];
  if (rawUrl === undefined || rawUrl === '') {
    return { stage: 'broadcast', status: 'skipped', detail: `${VALKEY_URL_ENV} is not set` };
  }
  let url;
  try {
    url = api.assertRedisUrl(rawUrl);
  } catch (error) {
    return { stage: 'broadcast', status: 'failed', detail: describeError(error) };
  }

  const httpServer = createServer();
  const sockets = [];
  let broadcast;
  try {
    broadcast = await api.attachBroadcast(httpServer, {
      allowedOrigins: [BROADCAST_ORIGIN],
      authenticate: (handshake) => {
        const auth = handshake.headers.authorization;
        return typeof auth === 'string' && auth.startsWith('Bearer ')
          ? auth.slice('Bearer '.length)
          : null;
      },
      authorizeChannel: (identity, channel) => channel === `room-${identity}`,
      redisUrl: url,
      onError: (error) => {
        console.error(`[jsails:verify] broadcast error: ${redact(describeError(error), [url])}`);
      },
    });
    await listen(httpServer);
    const port = httpServer.address().port;

    const clientA = await connectRaw(port, 'Bearer user-a');
    sockets.push(clientA);
    const clientB = await connectRaw(port, 'Bearer user-b');
    sockets.push(clientB);

    const authorized = await subscribeRaw(clientA, ['room-user-a']);
    if (authorized?.ok !== true) {
      throw new Error('authorized subscription was rejected');
    }

    // channel authorization: user-b is not allowed into room-user-a.
    const denied = await subscribeRaw(clientB, ['room-user-a']);
    if (denied?.ok !== false || denied?.error !== 'unauthorized') {
      throw new Error('unauthorized subscription was not denied');
    }

    const pending = nextRawEvent(clientA);
    broadcast.emit('room-user-a', 'greeting', { hello: 'world' });
    const event = await pending;
    if (event?.channel !== 'room-user-a' || event?.event !== 'greeting') {
      throw new Error('broadcast did not deliver the expected event');
    }
  } catch (error) {
    return {
      stage: 'broadcast',
      status: 'failed',
      detail: redact(describeError(error), [url]),
    };
  } finally {
    for (const socket of sockets) {
      try {
        socket.close();
      } catch {
        // Socket close is best-effort; a throwing close must not mask the result.
      }
    }
    if (broadcast !== undefined) {
      await broadcast.close().catch(() => {});
    } else {
      await new Promise((resolve) => httpServer.close(() => resolve()));
    }
  }
  return { stage: 'broadcast', status: 'ok', detail: 'pub/sub delivery + channel authorization' };
}

// ---------------------------------------------------------------------------
// Stage D: docker availability (read-only probe)
// ---------------------------------------------------------------------------

function runDockerStage(env) {
  if (env[DOCKER_ENV] !== '1') {
    return { stage: 'docker', status: 'skipped', detail: `${DOCKER_ENV} is not "1"` };
  }
  const probe = (args) => {
    try {
      execFileSync('docker', args, { stdio: 'ignore', timeout: DOCKER_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  };
  try {
    const available = probe(['version']) && probe(['info']);
    return {
      stage: 'docker',
      status: 'ok',
      detail: available ? 'docker daemon available' : 'docker daemon unavailable',
    };
  } catch (error) {
    return { stage: 'docker', status: 'failed', detail: describeError(error) };
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function printSummary(results) {
  for (const { stage, status, detail } of results) {
    const suffix = detail === '' ? '' : ` (${detail})`;
    console.log(`stage ${stage}: ${status}${suffix}`);
  }
  const ok = results.filter((r) => r.status === 'ok').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  console.log(`SUMMARY ok=${ok} failed=${failed} skipped=${skipped}`);
}

async function main() {
  if (!existsSync(DIST_INDEX)) {
    console.error(`Missing build output: ${DIST_INDEX} does not exist. Run "npm run build" first.`);
    process.exitCode = 1;
    return;
  }

  const api = await import(DIST_INDEX_URL);
  const env = process.env;

  const results = [];
  results.push(await runDatabaseStage(api, env));
  results.push(await runJobsStage(api, env));
  results.push(await runBroadcastStage(api, env));
  results.push(runDockerStage(env));

  printSummary(results);
  process.exitCode = results.some((r) => r.status === 'failed') ? 1 : 0;
}

main();
