import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { runJamalCommand, type JamalDeps } from '../src/jamal/command.js';
import {
  createDeploymentGeneratorRegistry,
  defineDeploymentGenerator,
  type DeploymentGenerator,
  type DeploymentGeneratorRegistry,
} from '../src/deploy/registry.js';

/**
 * Tests for the `jamal` builtin command. They exercise the command in-process
 * (never spawning a shell or a Docker/kamal process): argument handling and
 * usage, the dry-run plan, `--write` with exclusive creation, existing-file
 * protection, `--dir` targeting and traversal rejection, and the subcommand ->
 * generator-id mapping via an injected registry. No network, Docker, or kamal
 * call is ever made; writing happens into throwaway temp directories.
 */

interface Sinks {
  out: string[];
  err: string[];
}

function sinks(): Sinks {
  return { out: [], err: [] };
}

/** Build deps with a real (built-in) registry by default, or an injected one. */
function deps(
  cwd: string,
  s: Sinks,
  createRegistry?: (
    custom?: readonly DeploymentGenerator<unknown>[],
  ) => DeploymentGeneratorRegistry,
  loadDeployments?: JamalDeps['loadDeployments'],
): JamalDeps {
  return {
    createRegistry:
      createRegistry ??
      ((custom = []) => createDeploymentGeneratorRegistry({ generators: custom })),
    loadDeployments,
    cwd,
    stdout: (text) => s.out.push(text),
    stderr: (text) => s.err.push(text),
  };
}

const fixturesRoot = mkdtempSync(join(tmpdir(), 'jamal-test-'));

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

function makeDir(name: string): string {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** List every file under `dir` as a forward-slash relative path, sorted. */
function listFiles(dir: string): string[] {
  const result: string[] = [];
  const walk = (d: string, prefix: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(d, entry.name), `${prefix}${entry.name}/`);
      } else {
        result.push(`${prefix}${entry.name}`);
      }
    }
  };
  walk(dir, '');
  return result.sort();
}

describe('jamal: help and usage', () => {
  it('prints usage on --help without building a registry', async () => {
    const s = sinks();
    let built = false;
    const d = deps(makeDir('help'), s, () => {
      built = true;
      throw new Error('registry must not be built for --help');
    });

    const code = await runJamalCommand(['--help'], d);

    assert.equal(code, 0);
    assert.equal(built, false);
    assert.match(s.out.join('\n'), /Usage:/);
    assert.match(s.out.join('\n'), /jsails jamal <up\|down\|ps\|logs\|dev\|deploy\|targets>/);
    assert.match(s.out.join('\n'), /--write/);
    assert.match(s.out.join('\n'), /docker compose up -d/);
    assert.match(s.out.join('\n'), /Production is the default/);
    assert.equal(s.err.length, 0);
  });

  it('prints usage on a bare `jamal` without running a generator', async () => {
    const s = sinks();
    let built = false;
    const d = deps(makeDir('bare'), s, () => {
      built = true;
      throw new Error('registry must not be built without a subcommand');
    });

    const code = await runJamalCommand([], d);

    assert.equal(code, 2);
    assert.equal(built, false);
    assert.match(s.err.join('\n'), /subcommand is required/);
  });

  it('prints usage on an unknown subcommand without running a generator', async () => {
    const s = sinks();
    let built = false;
    const d = deps(makeDir('bad-sub'), s, () => {
      built = true;
      throw new Error('registry must not be built for an unknown subcommand');
    });

    const code = await runJamalCommand(['bogus'], d);

    assert.equal(code, 2);
    assert.equal(built, false);
    assert.match(s.err.join('\n'), /unknown subcommand/);
  });

  it('rejects an unknown flag as a usage error', async () => {
    const s = sinks();
    const code = await runJamalCommand(['dev', '--bogus'], deps(makeDir('flag'), s));

    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /Unknown option/);
  });
});

describe('jamal: dry run', () => {
  it('dev dry-run writes nothing and lists the planned files', async () => {
    const dir = makeDir('dry-dev');
    const s = sinks();

    const code = await runJamalCommand(['dev'], deps(dir, s));

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(listFiles(dir), []);
    const out = s.out.join('\n');
    assert.match(out, /nothing written/);
    for (const path of [
      'docker-compose.yml',
      'docker-compose.database.yml',
      'valkey.conf',
      'start-valkey.sh',
      '.env.example',
      '.env.database.example',
    ]) {
      assert.ok(out.includes(`  ${path}`), `expected "${path}" in the plan`);
    }
    assert.match(out, /docker compose up -d/);
  });

  it('deploy dry-run writes nothing and lists the planned files', async () => {
    const dir = makeDir('dry-deploy');
    const s = sinks();

    const code = await runJamalCommand(['deploy'], deps(dir, s));

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(listFiles(dir), []);
    const out = s.out.join('\n');
    assert.match(out, /nothing written/);
    assert.ok(out.includes('  config/deploy.yml'));
    assert.ok(out.includes('  .kamal/secrets'));
    assert.match(out, /kamal setup/);
  });
});

describe('jamal: --write', () => {
  it('dev --write produces exactly the valkey-dev + database-dev paths', async () => {
    const dir = makeDir('write-dev');
    const s = sinks();

    const code = await runJamalCommand(['dev', '--write'], deps(dir, s));

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(
      listFiles(dir),
      [
        '.env.database.example',
        '.env.example',
        'docker-compose.database.yml',
        'docker-compose.yml',
        'start-valkey.sh',
        'valkey.conf',
      ].sort(),
    );
    assert.match(s.out.join('\n'), /wrote 6 file\(s\), skipped 0/);
  });

  it('deploy --write produces exactly the valkey-kamal + database-kamal paths', async () => {
    const dir = makeDir('write-deploy');
    const s = sinks();

    const code = await runJamalCommand(['deploy', '--write'], deps(dir, s));

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(
      listFiles(dir),
      [
        'config/deploy.yml',
        'config/deploy.database.yml',
        'config/deploy.database-env.yml',
        'config/valkey/valkey.conf',
        'config/valkey/start-valkey.sh',
        '.kamal/secrets',
        '.kamal/secrets.database.example',
      ].sort(),
    );
    assert.match(s.out.join('\n'), /wrote 7 file\(s\), skipped 0/);
  });

  it('maps each subcommand to exactly its registry generators', async () => {
    const dir = makeDir('stub');
    const registry = createDeploymentGeneratorRegistry({
      includeBuiltins: false,
      generators: [
        defineDeploymentGenerator('valkey-dev', () => ({ files: { 'dev/valkey.txt': 'v' } })),
        defineDeploymentGenerator('database-dev', () => ({ files: { 'dev/db.txt': 'd' } })),
        defineDeploymentGenerator('valkey-kamal', () => ({ files: { 'prod/valkey.txt': 'v' } })),
        defineDeploymentGenerator('database-kamal', () => ({ files: { 'prod/db.txt': 'd' } })),
      ],
    });
    const s = sinks();
    const d = deps(dir, s, () => registry);

    assert.equal(await runJamalCommand(['dev', '--write'], d), 0);
    assert.deepEqual(listFiles(dir), ['dev/db.txt', 'dev/valkey.txt'].sort());

    assert.equal(await runJamalCommand(['deploy', '--write'], d), 0);
    assert.deepEqual(
      listFiles(dir),
      ['dev/db.txt', 'dev/valkey.txt', 'prod/db.txt', 'prod/valkey.txt'].sort(),
    );
  });
});

describe('jamal: existing-file protection', () => {
  it('never overwrites an existing file and reports it as skipped', async () => {
    const dir = makeDir('exists');
    writeFileSync(join(dir, 'docker-compose.yml'), 'ORIGINAL CONTENT');
    const s = sinks();

    const code = await runJamalCommand(['dev', '--write'], deps(dir, s));

    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(readFileSync(join(dir, 'docker-compose.yml'), 'utf8'), 'ORIGINAL CONTENT');
    const out = s.out.join('\n');
    assert.match(out, /skipped\s+docker-compose\.yml \(already exists\)/);
    assert.match(out, /wrote 5 file\(s\), skipped 1/);
    // The remaining five files were still written.
    assert.equal(existsSync(join(dir, 'valkey.conf')), true);
  });
});

describe('jamal: --dir', () => {
  it('writes into the chosen subdirectory, creating it', async () => {
    const dir = makeDir('dir-sub');
    const s = sinks();

    const code = await runJamalCommand(['dev', '--write', '--dir', 'deploy'], deps(dir, s));

    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(existsSync(join(dir, 'deploy', 'docker-compose.yml')), true);
    assert.equal(existsSync(join(dir, 'docker-compose.yml')), false);
  });

  it('rejects a --dir that escapes the working directory', async () => {
    const dir = makeDir('dir-escape');
    const s = sinks();

    const code = await runJamalCommand(['dev', '--write', '--dir', '../escape'], deps(dir, s));

    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /escapes the working directory/);
    assert.equal(existsSync(join(fixturesRoot, 'escape')), false);
    assert.deepEqual(listFiles(dir), []);
  });

  it('rejects an absolute --dir outside the working directory', async () => {
    const dir = makeDir('dir-abs');
    const s = sinks();

    const code = await runJamalCommand(
      ['dev', '--write', '--dir', '/tmp/jamal-abs-out'],
      deps(dir, s),
    );

    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /escapes the working directory/);
    assert.deepEqual(listFiles(dir), []);
  });
});

describe('jamal: deploy --target', () => {
  it('vercel dry-run plans only vercel.json and nothing is written', async () => {
    const dir = makeDir('target-vercel');
    const s = sinks();

    const code = await runJamalCommand(['deploy', '--target', 'vercel'], deps(dir, s));

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(listFiles(dir), []);
    const out = s.out.join('\n');
    assert.match(out, /nothing written/);
    assert.ok(out.includes('  vercel.json'));
    assert.ok(!out.includes('config/deploy.yml'));
    assert.match(out, /npx vercel deploy --prod/);
  });

  it('github dry-run plans the workflow and .nojekyll marker', async () => {
    const dir = makeDir('target-github');
    const s = sinks();

    const code = await runJamalCommand(['deploy', '--target', 'github'], deps(dir, s));

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(listFiles(dir), []);
    const out = s.out.join('\n');
    assert.ok(out.includes('  .github/workflows/pages.yml'));
    assert.ok(out.includes('  .nojekyll'));
    assert.match(out, /git push/);
  });

  it('vercel --write produces exactly vercel.json', async () => {
    const dir = makeDir('write-vercel');
    const s = sinks();

    const code = await runJamalCommand(['deploy', '--target', 'vercel', '--write'], deps(dir, s));

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(listFiles(dir), ['vercel.json']);
    assert.match(s.out.join('\n'), /wrote 1 file\(s\), skipped 0/);
    const content = readFileSync(join(dir, 'vercel.json'), 'utf8');
    assert.match(content, /"outputDirectory": "out"/);
  });

  it('github --write produces the workflow and .nojekyll marker', async () => {
    const dir = makeDir('write-github');
    const s = sinks();

    const code = await runJamalCommand(['deploy', '--target', 'github', '--write'], deps(dir, s));

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(listFiles(dir), ['.github/workflows/pages.yml', '.nojekyll'].sort());
    assert.match(s.out.join('\n'), /wrote 2 file\(s\), skipped 0/);
  });

  it('cloudflare --write uses the example project name', async () => {
    const dir = makeDir('write-cloudflare');
    const s = sinks();

    const code = await runJamalCommand(
      ['deploy', '--target', 'cloudflare', '--write'],
      deps(dir, s),
    );

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(listFiles(dir), ['wrangler.toml']);
    const content = readFileSync(join(dir, 'wrangler.toml'), 'utf8');
    assert.match(content, /name = "myapp"/);
    assert.match(content, /pages_build_output_dir = "out"/);
  });

  it('rejects an unknown --target as a usage error without running a generator', async () => {
    const s = sinks();
    let built = false;
    const d = deps(makeDir('target-bad'), s, () => {
      built = true;
      throw new Error('registry must not be built for an unknown target');
    });

    const code = await runJamalCommand(['deploy', '--target', 'bogus'], d);

    assert.equal(code, 2);
    assert.equal(built, false);
    assert.match(s.err.join('\n'), /unknown --target/);
  });

  it('maps each deploy target to exactly its registry generator', async () => {
    const dir = makeDir('target-stub');
    const registry = createDeploymentGeneratorRegistry({
      includeBuiltins: false,
      generators: [
        defineDeploymentGenerator('vercel-static', () => ({ files: { 'v/vercel.txt': 'v' } })),
        defineDeploymentGenerator('netlify-static', () => ({ files: { 'n/netlify.txt': 'n' } })),
        defineDeploymentGenerator('cloudflare-pages', () => ({ files: { 'c/wrangler.txt': 'c' } })),
        defineDeploymentGenerator('github-pages', () => ({ files: { 'g/workflow.txt': 'g' } })),
      ],
    });
    const s = sinks();
    const d = deps(dir, s, () => registry);

    assert.equal(await runJamalCommand(['deploy', '--target', 'vercel', '--write'], d), 0);
    assert.deepEqual(listFiles(dir), ['v/vercel.txt']);

    assert.equal(await runJamalCommand(['deploy', '--target', 'netlify', '--write'], d), 0);
    assert.deepEqual(listFiles(dir), ['n/netlify.txt', 'v/vercel.txt'].sort());

    assert.equal(await runJamalCommand(['deploy', '--target', 'cloudflare', '--write'], d), 0);
    assert.deepEqual(listFiles(dir), ['c/wrangler.txt', 'n/netlify.txt', 'v/vercel.txt'].sort());

    assert.equal(await runJamalCommand(['deploy', '--target', 'github', '--write'], d), 0);
    assert.deepEqual(
      listFiles(dir),
      ['c/wrangler.txt', 'g/workflow.txt', 'n/netlify.txt', 'v/vercel.txt'].sort(),
    );
  });
});

describe('jamal: custom deployments', () => {
  it('plans and writes a custom deployment target from the config', async () => {
    const dir = makeDir('custom-target');
    const s = sinks();
    let ran = 0;
    const custom = [
      defineDeploymentGenerator('cdn', () => {
        ran += 1;
        return { files: { 'cdn.txt': 'upload' } };
      }),
    ];
    const d = deps(dir, s, undefined, async () => custom);

    const code = await runJamalCommand(['deploy', '--target', 'cdn'], d);

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(listFiles(dir), []);
    const out = s.out.join('\n');
    assert.match(out, /nothing written/);
    assert.ok(out.includes('  cdn.txt'));
    assert.equal(ran, 1);

    const code2 = await runJamalCommand(['deploy', '--target', 'cdn', '--write'], d);

    assert.equal(code2, 0, s.err.join('\n'));
    assert.deepEqual(listFiles(dir), ['cdn.txt']);
    assert.equal(ran, 2);
  });

  it('rejects a custom deployment name that collides with a built-in generator', async () => {
    const dir = makeDir('collision');
    const s = sinks();
    let built = false;
    const d = deps(
      dir,
      s,
      () => {
        built = true;
        throw new Error('registry must not be built for a collision');
      },
      async () => [defineDeploymentGenerator('once', () => ({ files: {} }))],
    );

    const code = await runJamalCommand(['deploy'], d);

    assert.equal(code, 1);
    assert.equal(built, false);
    assert.match(s.err.join('\n'), /collides with a built-in deployment generator/);
  });

  it('lists available targets when --target is unknown', async () => {
    const dir = makeDir('unknown-target-list');
    const s = sinks();
    let built = false;
    const d = deps(
      dir,
      s,
      () => {
        built = true;
        throw new Error('registry must not be built for an unknown target');
      },
      async () => [defineDeploymentGenerator('cdn', () => ({ files: {} }))],
    );

    const code = await runJamalCommand(['deploy', '--target', 'nope'], d);

    assert.equal(code, 2);
    assert.equal(built, false);
    const err = s.err.join('\n');
    assert.match(err, /unknown --target/);
    assert.match(err, /cdn/);
    assert.match(err, /kamal/);
  });
});

describe('jamal: targets', () => {
  it('lists built-in and custom targets without running any generator', async () => {
    const dir = makeDir('targets');
    const s = sinks();
    let built = false;
    let ran = 0;
    const d = deps(
      dir,
      s,
      () => {
        built = true;
        throw new Error('registry must not be built for targets');
      },
      async () => [
        defineDeploymentGenerator('cdn', () => {
          ran += 1;
          return { files: {} };
        }),
      ],
    );

    const code = await runJamalCommand(['targets'], d);

    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(built, false);
    assert.equal(ran, 0);
    const out = s.out.join('\n');
    assert.match(out, /Built-in deployment targets:/);
    for (const name of ['kamal', 'vercel', 'netlify', 'cloudflare', 'github']) {
      assert.match(out, new RegExp(name));
    }
    assert.match(out, /cdn/);
  });

  it('reports the absence of a config when none is present', async () => {
    const dir = makeDir('targets-no-config');
    const s = sinks();

    const code = await runJamalCommand(['targets'], deps(dir, s));

    assert.equal(code, 0, s.err.join('\n'));
    assert.match(s.out.join('\n'), /no jsails\.app\.js config present/);
  });
});

describe('jamal: deploy --help', () => {
  it('lists the deploy targets and their commands without running a generator', async () => {
    const s = sinks();
    let built = false;
    const d = deps(makeDir('deploy-help'), s, () => {
      built = true;
      throw new Error('registry must not be built for --help');
    });

    const code = await runJamalCommand(['deploy', '--help'], d);

    assert.equal(code, 0);
    assert.equal(built, false);
    const out = s.out.join('\n');
    for (const name of ['kamal', 'vercel', 'netlify', 'cloudflare', 'github']) {
      assert.match(out, new RegExp(name));
    }
    assert.match(out, /npx vercel deploy --prod/);
    assert.match(out, /npx netlify deploy --prod/);
    assert.match(out, /npx wrangler pages deploy out/);
    assert.match(out, /--target/);
    assert.match(out, /deployments/);
    assert.match(out, /jsails\.app\.js/);
  });
});
