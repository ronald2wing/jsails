import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BUILTIN_DEPLOYMENT_GENERATOR_IDS,
  BUILTIN_DEPLOYMENT_GENERATORS,
} from '../src/deploy/builtin-generators.js';
import {
  generateDevDatabaseConfig,
  generateKamalDatabaseConfig,
  type KamalDatabaseOptions,
} from '../src/deploy/database-config.js';
import { generateKamalValkeyConfig, type KamalValkeyOptions } from '../src/deploy/kamal-config.js';
import {
  DeploymentRegistryError,
  createDeploymentGeneratorRegistry,
  defineDeploymentGenerator,
  type DeploymentFileMap,
  type DeploymentGenerator,
  type DeploymentGeneratorContext,
} from '../src/deploy/registry.js';
import { generateDevValkeyConfig } from '../src/deploy/valkey-config.js';
import { OnceConfigError, generateOnceConfig } from '../src/deploy/once-config.js';

/** Full-required Kamal Valkey options on a single host. */
function kamalValkeyOptions(): KamalValkeyOptions {
  return {
    service: 'myapp',
    image: 'ghcr.io/acme/myapp:git-sha',
    registry: { server: 'ghcr.io', username: 'acme' },
    hosts: { web: ['1.2.3.4'], worker: ['1.2.3.4'] },
    valkeyHost: '1.2.3.4',
  };
}

/** Full-required Kamal database options. */
function kamalDatabaseOptions(): KamalDatabaseOptions {
  return {
    service: 'myapp',
    host: '1.2.3.4',
    databaseName: 'appdb',
    username: 'app',
  };
}

/** A generator returning a fixed (possibly invalid) files map. */
function filesGenerator(name: string, files: unknown): DeploymentGenerator<unknown> {
  return {
    name,
    generate: () => ({ files }) as unknown as DeploymentFileMap,
  };
}

/** A custom-only registry containing a single generator that emits `files`. */
function probeRegistry(files: unknown) {
  return createDeploymentGeneratorRegistry({
    includeBuiltins: false,
    generators: [filesGenerator('probe', files)],
  });
}

describe('built-in deploy generator registry', () => {
  it('lists the nine built-in ids in deterministic order', () => {
    const registry = createDeploymentGeneratorRegistry();
    assert.deepEqual(registry.list(), [...BUILTIN_DEPLOYMENT_GENERATOR_IDS]);
    assert.equal(BUILTIN_DEPLOYMENT_GENERATORS.length, 9);
  });

  it('registers the four service/accessory generators first, then the ONCE preset, then hosting', () => {
    const registry = createDeploymentGeneratorRegistry();
    const list = registry.list();
    assert.deepEqual(list.slice(0, 4), [
      'valkey-dev',
      'valkey-kamal',
      'database-dev',
      'database-kamal',
    ]);
    assert.equal(list[4], 'once');
    assert.deepEqual(list.slice(5), [
      'vercel-static',
      'netlify-static',
      'cloudflare-pages',
      'github-pages',
    ]);
  });

  it('valkey-dev maps every field to a file path and preserves the generator output', async () => {
    const registry = createDeploymentGeneratorRegistry();
    const result = await registry.generate('valkey-dev');
    const direct = generateDevValkeyConfig();

    assert.equal(result.files['docker-compose.yml'], direct.compose);
    assert.equal(result.files['valkey.conf'], direct.valkeyConfig);
    assert.equal(result.files['start-valkey.sh'], direct.startupScript);
    assert.equal(result.files['.env.example'], direct.envExample);
    assert.ok(Object.isFrozen(result.files));
    assert.equal(Object.getPrototypeOf(result.files), null);
  });

  it('valkey-dev passes partial options through to the original defaults logic', async () => {
    const registry = createDeploymentGeneratorRegistry();
    const result = await registry.generate('valkey-dev', {
      serviceName: 'cache',
      database: 2,
    });
    const direct = generateDevValkeyConfig({
      serviceName: 'cache',
      database: 2,
    });
    assert.equal(result.files['docker-compose.yml'], direct.compose);
    assert.equal(result.files['.env.example'], direct.envExample);
  });

  it('valkey-kamal maps deploy/config/secrets fields to their files', async () => {
    const registry = createDeploymentGeneratorRegistry();
    const options = kamalValkeyOptions();
    const result = await registry.generate('valkey-kamal', options);
    const direct = generateKamalValkeyConfig(options);

    assert.equal(result.files['config/deploy.yml'], direct.deploy);
    assert.equal(result.files['config/valkey/valkey.conf'], direct.valkeyConfig);
    assert.equal(result.files['config/valkey/start-valkey.sh'], direct.startupScript);
    assert.equal(result.files['.kamal/secrets'], direct.secretsExample);
  });

  it('database-dev maps compose and env example fields', async () => {
    const registry = createDeploymentGeneratorRegistry();
    const result = await registry.generate('database-dev');
    const direct = generateDevDatabaseConfig();

    assert.equal(result.files['docker-compose.database.yml'], direct.compose);
    assert.equal(result.files['.env.database.example'], direct.envExample);
  });

  it('database-kamal maps fragments without claiming the whole deploy config', async () => {
    const registry = createDeploymentGeneratorRegistry();
    const options = kamalDatabaseOptions();
    const result = await registry.generate('database-kamal', options);
    const direct = generateKamalDatabaseConfig(options);

    assert.equal(result.files['config/deploy.database.yml'], direct.accessory);
    assert.equal(result.files['config/deploy.database-env.yml'], direct.envExample);
    assert.equal(result.files['.kamal/secrets.database.example'], direct.secretsExample);
    assert.ok(!('config/deploy.yml' in result.files));
  });

  it('once maps the preset files without claiming a whole deploy config', async () => {
    const registry = createDeploymentGeneratorRegistry();
    const result = await registry.generate('once');
    const direct = generateOnceConfig();

    assert.equal(result.files['Dockerfile.once'], direct.dockerfile);
    assert.equal(result.files['.dockerignore'], direct.dockerignore);
    assert.equal(result.files['jsails.once.js'], direct.jsailsConfig);
    assert.ok(!('config/deploy.yml' in result.files));
  });

  it('once rejects invalid options through the registry', async () => {
    const registry = createDeploymentGeneratorRegistry();
    await assert.rejects(registry.generate('once', { baseImage: '' }), OnceConfigError);
    await assert.rejects(registry.generate('once', []), TypeError);
  });

  it('rejects non-plain-object input before calling the underlying generator', async () => {
    const registry = createDeploymentGeneratorRegistry();
    await assert.rejects(registry.generate('valkey-dev', []), TypeError);
    await assert.rejects(registry.generate('valkey-dev', null), TypeError);
    await assert.rejects(registry.generate('database-dev', 'nope'), TypeError);
  });
});

describe('custom deploy generators', () => {
  it('supports a custom-only registry with includeBuiltins: false', async () => {
    const cloud = defineDeploymentGenerator('cloud', () => ({
      files: { 'infra/cloud.tf': 'resource "x" {}' },
    }));
    const registry = createDeploymentGeneratorRegistry({
      includeBuiltins: false,
      generators: [cloud],
    });

    assert.deepEqual(registry.list(), ['cloud']);
    const result = await registry.generate('cloud');
    assert.deepEqual({ ...result.files }, { 'infra/cloud.tf': 'resource "x" {}' });
  });

  it('excludes the ONCE preset (and every builtin) when includeBuiltins is false', () => {
    const registry = createDeploymentGeneratorRegistry({
      includeBuiltins: false,
    });
    assert.deepEqual(registry.list(), []);
    assert.ok(!registry.list().includes('once'));
  });

  it('appends custom generators after the built-ins by default', () => {
    const registry = createDeploymentGeneratorRegistry({
      generators: [filesGenerator('cloud', { 'a.txt': 'x' })],
    });
    assert.deepEqual(registry.list(), [...BUILTIN_DEPLOYMENT_GENERATOR_IDS, 'cloud']);
  });

  it('awaits async generators', async () => {
    const registry = createDeploymentGeneratorRegistry({
      includeBuiltins: false,
      generators: [filesGenerator('slow', { 'a.txt': 'b' })],
    });
    const result = await registry.generate('slow');
    assert.equal(result.files['a.txt'], 'b');
  });

  it('passes input and context through to a custom generator', async () => {
    let seenInput: unknown;
    let seenContext: DeploymentGeneratorContext | undefined;
    const echo = defineDeploymentGenerator<{ value: number }>('echo', (input, context) => {
      seenInput = input;
      seenContext = context;
      return { files: { 'echo.txt': String(input.value) } };
    });
    const registry = createDeploymentGeneratorRegistry({
      includeBuiltins: false,
      generators: [echo],
    });

    const context: DeploymentGeneratorContext = {
      signal: new AbortController().signal,
    };
    const result = await registry.generate('echo', { value: 7 }, context);
    assert.deepEqual(seenInput, { value: 7 });
    assert.equal(seenContext, context);
    assert.equal(result.files['echo.txt'], '7');
  });
});

describe('registration rules', () => {
  it('rejects a duplicate generator name', () => {
    const registry = createDeploymentGeneratorRegistry({
      includeBuiltins: false,
    });
    registry.register(filesGenerator('dup', { 'a.txt': 'x' }));
    assert.throws(
      () => registry.register(filesGenerator('dup', { 'b.txt': 'y' })),
      DeploymentRegistryError,
    );
  });

  it('does not silently override a built-in', () => {
    const registry = createDeploymentGeneratorRegistry();
    assert.throws(
      () => registry.register(filesGenerator('valkey-dev', { 'a.txt': 'x' })),
      DeploymentRegistryError,
    );
  });

  it('rejects invalid generator names', () => {
    const registry = createDeploymentGeneratorRegistry({
      includeBuiltins: false,
    });
    for (const name of ['', 'Upper', 'has space', '__proto__', 'a/b', '.hidden']) {
      assert.throws(
        () => registry.register(filesGenerator(name, { 'a.txt': 'x' })),
        DeploymentRegistryError,
      );
    }
  });

  it('rejects malformed generator objects', () => {
    const registry = createDeploymentGeneratorRegistry({
      includeBuiltins: false,
    });
    assert.throws(
      () => registry.register(null as unknown as DeploymentGenerator),
      DeploymentRegistryError,
    );
    assert.throws(
      () => registry.register({ name: 'x' } as unknown as DeploymentGenerator),
      DeploymentRegistryError,
    );
    assert.throws(
      () =>
        registry.register({
          name: 'x',
          generate: 'nope',
        } as unknown as DeploymentGenerator),
      DeploymentRegistryError,
    );
  });

  it('rejects generating an unregistered name', async () => {
    const registry = createDeploymentGeneratorRegistry({
      includeBuiltins: false,
    });
    await assert.rejects(registry.generate('missing'), DeploymentRegistryError);
  });

  it('rejects a non-array options.generators', () => {
    assert.throws(
      () =>
        createDeploymentGeneratorRegistry({
          includeBuiltins: false,
          generators: 'nope' as unknown as readonly DeploymentGenerator[],
        }),
      DeploymentRegistryError,
    );
  });
});

describe('generated path validation', () => {
  const unsafePaths = [
    '',
    '/etc/passwd',
    'C:/windows/system32',
    'C:\\windows',
    'a\\b',
    '..',
    '../escape',
    'a/../b',
    '.',
    './a',
    'a/./b',
    'a//b',
    'a/',
    '__proto__',
    'a/__proto__/b',
    'a:b',
    'a*b',
    'a?b',
    'a<b',
    'a>b',
    'a|b',
    'a"b',
    'a\u0000b',
    'a\u001fb',
    'a\u007fb',
    '//server/share',
  ];

  for (const path of unsafePaths) {
    it(`rejects the path ${JSON.stringify(path)}`, async () => {
      await assert.rejects(
        probeRegistry({ [path]: 'content' }).generate('probe'),
        DeploymentRegistryError,
      );
    });
  }

  it('allows dotfile segments such as .kamal/secrets and .env.example', async () => {
    const registry = probeRegistry({
      '.kamal/secrets': 's',
      '.env.example': 'e',
      'config/.hidden/file.txt': 'h',
    });
    const result = await registry.generate('probe');
    assert.deepEqual(Object.keys(result.files).sort(), [
      '.env.example',
      '.kamal/secrets',
      'config/.hidden/file.txt',
    ]);
  });

  it('rejects a path used as both a file and a directory', async () => {
    await assert.rejects(
      probeRegistry({ a: 'x', 'a/b': 'y' }).generate('probe'),
      DeploymentRegistryError,
    );
    await assert.rejects(
      probeRegistry({ 'a/b': 'y', a: 'x' }).generate('probe'),
      DeploymentRegistryError,
    );
    await assert.rejects(
      probeRegistry({ 'a/b/c': 'x', 'a/b': 'y' }).generate('probe'),
      DeploymentRegistryError,
    );
  });

  it('rejects non-string values without echoing them', async () => {
    const secret = 'super-secret-value';
    await assert.rejects(
      probeRegistry({ 'leak.txt': { password: secret } }).generate('probe'),
      (error: unknown) => {
        assert.ok(error instanceof DeploymentRegistryError);
        assert.ok(!error.message.includes(secret));
        return true;
      },
    );
    await assert.rejects(probeRegistry({ 'a.txt': 1 }).generate('probe'), DeploymentRegistryError);
    await assert.rejects(
      probeRegistry({ 'a.txt': null }).generate('probe'),
      DeploymentRegistryError,
    );
  });

  it('rejects a __proto__ key and does not pollute Object.prototype', async () => {
    const parsed = JSON.parse('{"__proto__":"evil","ok.txt":"x"}') as Record<string, string>;
    await assert.rejects(probeRegistry(parsed).generate('probe'), DeploymentRegistryError);

    const nullProto: Record<string, string> = Object.create(null);
    nullProto['__proto__'] = 'evil';
    await assert.rejects(probeRegistry(nullProto).generate('probe'), DeploymentRegistryError);

    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
  });

  it('rejects invalid generator result shapes', async () => {
    await assert.rejects(probeRegistry(undefined).generate('probe'), DeploymentRegistryError);
    const registry = createDeploymentGeneratorRegistry({
      includeBuiltins: false,
    });
    registry.register(filesGenerator('no-files', 'x'));
    await assert.rejects(registry.generate('no-files'), DeploymentRegistryError);
  });
});

describe('error propagation', () => {
  it('propagates a synchronous generator error unchanged', async () => {
    const boom = new Error('synchronous boom');
    const registry = createDeploymentGeneratorRegistry({
      includeBuiltins: false,
    });
    registry.register({
      name: 'sync-boom',
      generate() {
        throw boom;
      },
    });
    await assert.rejects(registry.generate('sync-boom'), (error: unknown) => error === boom);
  });

  it('propagates an async generator rejection unchanged', async () => {
    const boom = new Error('asynchronous boom');
    const registry = createDeploymentGeneratorRegistry({
      includeBuiltins: false,
      generators: [
        defineDeploymentGenerator('async-boom', async () => {
          throw boom;
        }),
      ],
    });
    await assert.rejects(registry.generate('async-boom'), (error: unknown) => error === boom);
  });

  it('propagates an underlying built-in validation error', async () => {
    const registry = createDeploymentGeneratorRegistry();
    await assert.rejects(
      registry.generate('valkey-kamal', { service: 'myapp' }),
      (error: unknown) => error instanceof Error && error.name === 'ValkeyConfigError',
    );
  });
});
