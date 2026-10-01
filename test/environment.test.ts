import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  DATABASE_HOST_ENV,
  DATABASE_NAME_ENV,
  DATABASE_PASSWORD_ENV,
  DATABASE_PORT_ENV,
  DATABASE_TYPE_ENV,
  DATABASE_USER_ENV,
  EnvironmentError,
  readDatabaseEnvironment,
  readEnvironment,
  readValkeyEnvironment,
  REDIS_URL_ENV,
  VALKEY_URL_ENV,
  type DatabaseEnvironment,
  type EnvironmentIssue,
} from '../src/config/environment.js';

/** Run `fn`, assert it throws an EnvironmentError, and return that error. */
function capture(fn: () => unknown): EnvironmentError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof EnvironmentError, `expected EnvironmentError, got ${String(error)}`);
    return error;
  }
  throw new Error('expected an EnvironmentError, but nothing was thrown');
}

/** Full required database source without a driver, for reuse. */
function databaseSource(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    [DATABASE_HOST_ENV]: 'db.internal',
    [DATABASE_USER_ENV]: 'app_user',
    [DATABASE_PASSWORD_ENV]: 'p@ss word',
    [DATABASE_NAME_ENV]: 'app_db',
    ...overrides,
  };
}

function pathOf(issue: EnvironmentIssue): string {
  return issue.path.join('.');
}

describe('readEnvironment', () => {
  it('applies Zod defaults for optional variables and infers the output type', () => {
    const schema = z.object({
      PORT: z.coerce.number().default(3000),
      HOST: z.string().default('localhost'),
    });

    const result: { PORT: number; HOST: string } = readEnvironment(schema, {});

    assert.deepEqual(result, { PORT: 3000, HOST: 'localhost' });
  });

  it('validates a custom source without mutating it', () => {
    const source: Record<string, string | undefined> = { PORT: '8080' };
    const snapshot = { ...source };

    const result = readEnvironment(z.object({ PORT: z.string() }), source);

    assert.deepEqual(result, { PORT: '8080' });
    assert.deepEqual(source, snapshot);
  });

  it('isolates the caller source from a mutating preprocess or transform', () => {
    const source: Record<string, string | undefined> = { A: 'original' };
    const schema = z.preprocess(
      (input) => {
        (input as Record<string, unknown>).A = 'mutated-by-schema';
        return input;
      },
      z.object({ A: z.string() }),
    );

    const result = readEnvironment(schema, source);

    assert.deepEqual(result, { A: 'mutated-by-schema' });
    assert.deepEqual(source, { A: 'original' });
  });

  it('strips unknown keys by default', () => {
    const result = readEnvironment(z.object({ A: z.string() }), { A: '1', B: '2' });

    assert.deepEqual(result, { A: '1' });
  });

  it('honors a strict schema without echoing unrecognized key names', () => {
    const schema = z.object({ A: z.string() }).strict();

    const error = capture(() => readEnvironment(schema, { A: '1', SECRET_KEY: 'leak-me' }));

    assert.equal(error.issues[0]?.code, 'unrecognized_keys');
    assert.equal(error.issues[0]?.path.length, 0);
    assert.ok(!error.message.includes('SECRET_KEY'));
    assert.ok(!error.message.includes('leak-me'));
  });

  it('redacts custom Zod messages that may embed input', () => {
    const schema = z.object({
      TOKEN: z.string().refine(() => false, { message: 'super-secret-token-value' }),
    });

    const error = capture(() => readEnvironment(schema, { TOKEN: 'super-secret-token-value' }));

    assert.equal(error.issues[0]?.path[0], 'TOKEN');
    assert.equal(error.issues[0]?.code, 'custom');
    assert.ok(!error.message.includes('super-secret-token-value'));
  });

  it('sanitizes arbitrary transform/refine throws and sets no cause', () => {
    const schema = z.object({ A: z.string() }).transform(() => {
      throw new Error('boom-secret-credential');
    });

    const error = capture(() => readEnvironment(schema, { A: 'x' }));

    assert.ok(!error.message.includes('boom-secret-credential'));
    assert.equal(error.cause, undefined);
  });

  it('does not set a cause on ordinary Zod failures', () => {
    const error = capture(() =>
      readEnvironment(z.object({ A: z.number() }), { A: 'not-a-number' }),
    );

    assert.equal(error.issues[0]?.code, 'invalid_type');
    assert.equal(error.cause, undefined);
  });

  it('reads the default process.env source at call time, never at import time', () => {
    const key = 'JSAILS_ENVIRONMENT_PROBE';
    const before = process.env[key];
    process.env[key] = 'call-time-value';
    try {
      const result = readEnvironment(z.object({ [key]: z.string() }));
      assert.deepEqual(result, { [key]: 'call-time-value' });
    } finally {
      if (before === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = before;
      }
    }
  });
});

describe('readDatabaseEnvironment', () => {
  it('defaults to MariaDB on port 3306 with the injected source', () => {
    const env = databaseSource();

    const result: DatabaseEnvironment = readDatabaseEnvironment(env);

    assert.deepEqual(result, {
      type: 'mariadb',
      host: 'db.internal',
      port: 3306,
      username: 'app_user',
      password: 'p@ss word',
      database: 'app_db',
    });
  });

  it('defaults Postgres to port 5432', () => {
    const result = readDatabaseEnvironment(databaseSource({ [DATABASE_TYPE_ENV]: 'postgres' }));

    assert.equal(result.type, 'postgres');
    assert.equal(result.port, 5432);
  });

  it('keeps the legacy mysql driver available on port 3306', () => {
    const result = readDatabaseEnvironment(databaseSource({ [DATABASE_TYPE_ENV]: 'mysql' }));

    assert.equal(result.type, 'mysql');
    assert.equal(result.port, 3306);
  });

  it('accepts an explicit canonical decimal port override', () => {
    const result = readDatabaseEnvironment(
      databaseSource({ [DATABASE_TYPE_ENV]: 'postgres', [DATABASE_PORT_ENV]: '6543' }),
    );

    assert.equal(result.port, 6543);
  });

  it('accepts the canonical port bounds 1 and 65535', () => {
    assert.equal(readDatabaseEnvironment(databaseSource({ [DATABASE_PORT_ENV]: '1' })).port, 1);
    assert.equal(
      readDatabaseEnvironment(databaseSource({ [DATABASE_PORT_ENV]: '65535' })).port,
      65535,
    );
  });

  it('rejects non-canonical, out-of-range, and non-positive ports', () => {
    const invalid = [
      '0',
      '65536',
      '-1',
      '+3306',
      '3306.5',
      '1e3',
      '0x1234',
      ' 3306',
      '3306 ',
      '',
      'abc',
    ];
    for (const value of invalid) {
      const error = capture(() =>
        readDatabaseEnvironment(databaseSource({ [DATABASE_PORT_ENV]: value })),
      );
      assert.equal(error.issues[0]?.path[0], DATABASE_PORT_ENV, `port ${JSON.stringify(value)}`);
    }
  });

  it('rejects missing and explicitly empty required variables', () => {
    const required = [
      DATABASE_HOST_ENV,
      DATABASE_USER_ENV,
      DATABASE_PASSWORD_ENV,
      DATABASE_NAME_ENV,
    ];
    for (const name of required) {
      const missing = databaseSource();
      delete missing[name];
      const missingError = capture(() => readDatabaseEnvironment(missing));
      assert.equal(missingError.issues[0]?.code, 'required');
      assert.equal(pathOf(missingError.issues[0]), name);

      const emptyError = capture(() => readDatabaseEnvironment(databaseSource({ [name]: '' })));
      assert.equal(emptyError.issues[0]?.code, 'required');
      assert.equal(pathOf(emptyError.issues[0]), name);
    }
  });

  it('preserves the password verbatim and does not restrict user/database identifiers', () => {
    const result = readDatabaseEnvironment(
      databaseSource({
        [DATABASE_PASSWORD_ENV]: '  p@ss:word/with spaces  ',
        [DATABASE_USER_ENV]: 'user-1@local',
        [DATABASE_NAME_ENV]: 'my app-db.v2',
      }),
    );

    assert.equal(result.password, '  p@ss:word/with spaces  ');
    assert.equal(result.username, 'user-1@local');
    assert.equal(result.database, 'my app-db.v2');
  });

  it('rejects an invalid DATABASE_TYPE without echoing the value', () => {
    const error = capture(() =>
      readDatabaseEnvironment(databaseSource({ [DATABASE_TYPE_ENV]: 'sqlite' })),
    );

    assert.equal(error.issues[0]?.path[0], DATABASE_TYPE_ENV);
    assert.equal(error.issues[0]?.code, 'invalid_type');
    assert.ok(!error.message.includes('sqlite'));
  });

  it('does not fall back to process.env when an explicit source is given', () => {
    const names = [DATABASE_HOST_ENV, DATABASE_USER_ENV, DATABASE_PASSWORD_ENV, DATABASE_NAME_ENV];
    const previous = names.map((name) => process.env[name]);
    for (const name of names) {
      process.env[name] = 'from-process-env';
    }
    try {
      const error = capture(() => readDatabaseEnvironment({}));
      assert.equal(error.issues[0]?.code, 'required');
      assert.equal(pathOf(error.issues[0]), DATABASE_HOST_ENV);
    } finally {
      names.forEach((name, index) => {
        const value = previous[index];
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      });
    }
  });

  it('does not interpolate values into a connection URL', () => {
    const result = readDatabaseEnvironment(databaseSource());

    assert.deepEqual(Object.keys(result).sort(), [
      'database',
      'host',
      'password',
      'port',
      'type',
      'username',
    ]);
  });
});

describe('readValkeyEnvironment', () => {
  it('prefers VALKEY_URL over REDIS_URL', () => {
    const result = readValkeyEnvironment({
      [VALKEY_URL_ENV]: 'redis://valkey:6379/0',
      [REDIS_URL_ENV]: 'redis://redis:6379',
    });

    assert.equal(result.redisUrl, 'redis://valkey:6379/0');
  });

  it('falls back to REDIS_URL and accepts rediss://', () => {
    assert.equal(
      readValkeyEnvironment({ [REDIS_URL_ENV]: 'redis://redis:6379' }).redisUrl,
      'redis://redis:6379',
    );
    assert.equal(
      readValkeyEnvironment({ [VALKEY_URL_ENV]: 'rediss://secure:6380' }).redisUrl,
      'rediss://secure:6380',
    );
  });

  it('errors when no URL is configured (opt-in service)', () => {
    const error = capture(() => readValkeyEnvironment({}));

    assert.equal(error.issues[0]?.code, 'invalid_value');
    assert.equal(error.cause, undefined);
  });

  it('does not fall back to process.env when an explicit source is given', () => {
    const previous = process.env[VALKEY_URL_ENV];
    process.env[VALKEY_URL_ENV] = 'redis://from-process-env:6379';
    try {
      const error = capture(() => readValkeyEnvironment({}));
      assert.equal(error.issues[0]?.code, 'invalid_value');
      assert.ok(!error.message.includes('from-process-env'));
    } finally {
      if (previous === undefined) {
        delete process.env[VALKEY_URL_ENV];
      } else {
        process.env[VALKEY_URL_ENV] = previous;
      }
    }
  });

  it('never leaks a URL that embeds a password or uses a wrong scheme', () => {
    const error = capture(() =>
      readValkeyEnvironment({ [VALKEY_URL_ENV]: 'http://user:supersecret@host:1234' }),
    );

    assert.ok(!error.message.includes('supersecret'));
    assert.ok(!error.message.includes('http://'));
    assert.equal(error.cause, undefined);
  });
});

describe('EnvironmentError', () => {
  it('is an Error carrying structured, value-free issues', () => {
    const error = capture(() =>
      readEnvironment(z.object({ A: z.number() }), { A: 'not-a-number' }),
    );

    assert.ok(error instanceof Error);
    assert.equal(error.name, 'EnvironmentError');
    assert.ok(Array.isArray(error.issues));
    for (const entry of error.issues) {
      assert.ok(Array.isArray(entry.path));
      assert.equal(typeof entry.code, 'string');
      assert.equal(typeof entry.message, 'string');
    }
  });
});
