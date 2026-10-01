import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  AppConfigError,
  defineAppConfig,
  type ConfigSchemaIssue,
} from '../../src/app/config-schema.js';
import { appConfigSchema } from '../../src/app/config/schema.js';

function capture(fn: () => unknown): AppConfigError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof AppConfigError, `expected AppConfigError, got ${String(error)}`);
    return error;
  }
  throw new Error('expected an AppConfigError, but nothing was thrown');
}

function issuesOf(error: AppConfigError): readonly ConfigSchemaIssue[] {
  assert.ok(error.issues !== undefined, 'expected issues to be present');
  return error.issues;
}

describe('defineAppConfig', () => {
  it('validates and returns a typed config against the built-in schema', () => {
    const config = defineAppConfig(appConfigSchema, {
      port: 3000,
      host: '127.0.0.1',
    });

    assert.equal(config.port, 3000);
    assert.equal(config.host, '127.0.0.1');
  });

  it('returns the config with defaults applied by the schema', () => {
    const config = defineAppConfig(appConfigSchema, {});

    // port has no zod default — it's left undefined (schema marks it optional)
    assert.equal(config.port, undefined);
    assert.ok(!('host' in config) || config.host === undefined);
  });

  it('rejects an unknown top-level key', () => {
    const err = capture(() =>
      defineAppConfig(appConfigSchema, {
        port: 3000,
        madeUpKey: true,
      } as any),
    );

    const issues = issuesOf(err);
    assert.ok(issues.length >= 1, 'expected at least one issue');
    const unrecognized = issues.filter((i) => i.code === 'unrecognized_keys');
    assert.ok(unrecognized.length >= 1, 'expected an unrecognized_keys issue');
  });

  it('rejects a wrong-typed port (string instead of number)', () => {
    const err = capture(() =>
      defineAppConfig(appConfigSchema, {
        port: '3000',
      } as any),
    );

    const issues = issuesOf(err);
    const portIssue = issues.find((i) => i.path.join('.') === 'port');
    assert.ok(portIssue !== undefined, 'expected an issue for port');
    assert.equal(portIssue.code, 'invalid_type');
    // Message must never echo the input value.
    assert.ok(!portIssue.message.includes('3000'), 'message must not echo the input value');
  });

  it('rejects a port below the minimum', () => {
    const err = capture(() =>
      defineAppConfig(appConfigSchema, {
        port: -1,
      } as any),
    );

    const issues = issuesOf(err);
    const portIssue = issues.find((i) => i.path.join('.') === 'port');
    assert.ok(portIssue !== undefined, 'expected an issue for port');
    assert.equal(portIssue.code, 'too_small');
  });

  it('rejects a port above the maximum', () => {
    const err = capture(() =>
      defineAppConfig(appConfigSchema, {
        port: 100000,
      } as any),
    );

    const issues = issuesOf(err);
    const portIssue = issues.find((i) => i.path.join('.') === 'port');
    assert.ok(portIssue !== undefined, 'expected an issue for port');
    assert.equal(portIssue.code, 'too_big');
  });

  it('accepts rootDir and pages as string fields', () => {
    const config = defineAppConfig(appConfigSchema, {
      rootDir: './src',
      pages: 'views',
      host: '0.0.0.0',
    });

    assert.equal(config.rootDir, './src');
    assert.equal(config.pages, 'views');
    assert.equal(config.host, '0.0.0.0');
  });

  it('accepts healthPath as a string', () => {
    const config = defineAppConfig(appConfigSchema, {
      healthPath: '/_health',
    });

    assert.equal(config.healthPath, '/_health');
  });

  it('accepts healthPath as false (disabled)', () => {
    const config = defineAppConfig(appConfigSchema, {
      healthPath: false,
    });

    assert.equal(config.healthPath, false);
  });

  it('accepts publicOrigin as a string', () => {
    const config = defineAppConfig(appConfigSchema, {
      publicOrigin: 'https://example.com',
    });

    assert.equal(config.publicOrigin, 'https://example.com');
  });

  it('accepts function fields (authorize, resolveSession)', () => {
    const authorize = () => true;
    const resolveSession = () => ({ id: 1, email: 'user@example.com' });

    const config = defineAppConfig(appConfigSchema, {
      authorize,
      resolveSession,
    } as any);

    // Pass-through: the schema marks them as z.unknown().optional().
    assert.equal(config.authorize, authorize);
    assert.equal(config.resolveSession, resolveSession);
  });

  it('accepts setup as a function', () => {
    const setup = () => undefined;
    const config = defineAppConfig(appConfigSchema, {
      setup,
    } as any);

    assert.equal(config.setup, setup);
  });

  it('accepts the plugin config with valid ids', () => {
    const config = defineAppConfig(appConfigSchema, {
      plugins: {
        enabled: ['auth', 'cache'],
        downloads: true,
        managed: false,
      },
    });

    assert.deepEqual(config.plugins, {
      enabled: ['auth', 'cache'],
      downloads: true,
      managed: false,
    });
  });

  it('rejects an invalid plugin id pattern', () => {
    const err = capture(() =>
      defineAppConfig(appConfigSchema, {
        plugins: { enabled: ['bad id!'] },
      } as any),
    );

    const issues = issuesOf(err);
    assert.ok(issues.length >= 1, 'expected at least one issue');
    assert.ok(
      issues.some((i) => i.code === 'invalid_format' || i.code === 'invalid_string'),
      'expected an invalid_format or invalid_string code',
    );
  });

  it('rejects unknown keys inside the plugins block', () => {
    const err = capture(() =>
      defineAppConfig(appConfigSchema, {
        plugins: {
          enabled: ['auth'],
          madeUp: true,
        },
      } as any),
    );

    const issues = issuesOf(err);
    const unrecognized = issues.filter((i) => i.code === 'unrecognized_keys');
    assert.ok(unrecognized.length >= 1, 'expected an unrecognized_keys issue');
  });

  it('works with a custom Zod schema', () => {
    const customSchema = z.object({
      apiVersion: z.number().int().min(1),
      features: z.array(z.string()).default([]),
    });

    const config: { apiVersion: number; features: string[] } = defineAppConfig(customSchema, {
      apiVersion: 2,
      features: ['beta'],
    });

    assert.equal(config.apiVersion, 2);
    assert.deepEqual(config.features, ['beta']);
  });

  it('rejects a custom schema with a mistyped field', () => {
    const customSchema = z.object({
      apiVersion: z.number().int().min(1),
    });

    const err = capture(() =>
      defineAppConfig(customSchema, {
        apiVersion: 'v2',
      } as any),
    );

    const issues = issuesOf(err);
    assert.equal(issues.length, 1);
    assert.ok(issues[0] !== undefined);
    assert.equal(issues[0].code, 'invalid_type');
    // The path must be an array, never include the raw value.
    assert.deepEqual(issues[0].path, ['apiVersion']);
  });

  it('works with a strict custom schema (unknown keys rejected)', () => {
    const customSchema = z
      .object({
        apiVersion: z.number().int().min(1),
      })
      .strict();

    const err = capture(() =>
      defineAppConfig(customSchema, {
        apiVersion: 1,
        debugMode: true,
      } as any),
    );

    const issues = issuesOf(err);
    const unrecognized = issues.filter((i) => i.code === 'unrecognized_keys');
    assert.ok(unrecognized.length >= 1, 'expected an unrecognized_keys issue');
  });

  it('does not mutate the input config object', () => {
    const input = { port: 4000, host: '0.0.0.0' };
    const original = { ...input };

    defineAppConfig(appConfigSchema, input);

    assert.deepEqual(input, original);
  });

  it('returns a config with the same value as the input', () => {
    const input = { port: 5000 };
    const config = defineAppConfig(appConfigSchema, input);

    assert.deepEqual(config, input);
  });

  it('error message never echoes the raw port value', () => {
    const err = capture(() =>
      defineAppConfig(appConfigSchema, {
        port: 99999,
      } as any),
    );

    assert.ok(!err.message.includes('99999'), 'error message must not echo the input value');
  });

  it('error issues carry path as an array, not a dotted string', () => {
    const err = capture(() =>
      defineAppConfig(appConfigSchema, {
        port: 'abc',
      } as any),
    );

    const issues = issuesOf(err);
    assert.ok(issues.length > 0);
    for (const issue of issues) {
      assert.ok(Array.isArray(issue.path), 'issue.path must be an array');
      // No element should contain a dot — the path is split.
      for (const seg of issue.path) {
        assert.ok(
          typeof seg !== 'string' || !seg.includes('.'),
          'string path segment should not contain a dot',
        );
      }
    }
  });

  it('accepts maxBodyBytes as a positive integer', () => {
    const config = defineAppConfig(appConfigSchema, {
      maxBodyBytes: 1048576,
    });

    assert.equal(config.maxBodyBytes, 1048576);
  });

  it('accepts shutdownTimeoutMs within bounds', () => {
    const config = defineAppConfig(appConfigSchema, {
      shutdownTimeoutMs: 10000,
    });

    assert.equal(config.shutdownTimeoutMs, 10000);
  });

  it('rejects shutdownTimeoutMs above the maximum', () => {
    const err = capture(() =>
      defineAppConfig(appConfigSchema, {
        shutdownTimeoutMs: 999_999,
      } as any),
    );

    const issues = issuesOf(err);
    assert.ok(issues.some((i) => i.path.join('.') === 'shutdownTimeoutMs'));
  });

  it('rejects maxBodyBytes when not positive', () => {
    const err = capture(() =>
      defineAppConfig(appConfigSchema, {
        maxBodyBytes: 0,
      } as any),
    );

    const issues = issuesOf(err);
    assert.ok(issues.some((i) => i.path.join('.') === 'maxBodyBytes'));
  });
});
