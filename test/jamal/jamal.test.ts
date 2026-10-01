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

import { runJamalCommand, type JamalDeps } from '../../src/jamal/command.js';
import { normalizeJamalConfig } from '../../src/jamal/config.js';
import type { CommandResult, CommandRunner } from '../../src/jamal/docker.js';
import {
  createDeploymentGeneratorRegistry,
  defineDeploymentGenerator,
  type DeploymentGenerator,
  type DeploymentGeneratorRegistry,
} from '../../src/deploy/registry.js';

/** A minimal valid jamal config for the managed `.jamal/compose.yml` path. */
function fakeJamalConfig(): ReturnType<typeof normalizeJamalConfig> {
  return normalizeJamalConfig({
    service: 'myapp',
    image: 'ghcr.io/acme/myapp:latest',
  });
}

/** Record the argv/cwd of each compose call without spawning a process. */
function recordingRunner(spec: CommandResult = { exitCode: 0, stdout: '', stderr: '' }): {
  calls: { argv: readonly string[]; cwd: string }[];
  run: CommandRunner;
} {
  const calls: { argv: readonly string[]; cwd: string }[] = [];
  const run: CommandRunner = async (argv, options) => {
    calls.push({ argv, cwd: options.cwd });
    return spec;
  };
  return { calls, run };
}

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
  loadJamalConfig?: JamalDeps['loadJamalConfig'],
  runCommand?: CommandRunner,
): JamalDeps {
  return {
    createRegistry:
      createRegistry ??
      ((custom = []) => createDeploymentGeneratorRegistry({ generators: custom })),
    loadDeployments,
    loadJamalConfig,
    cwd,
    stdout: (text) => s.out.push(text),
    stderr: (text) => s.err.push(text),
    runCommand,
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
    assert.match(
      s.out.join('\n'),
      /jsails jamal <up\|down\|ps\|logs\|exec\|status\|dev\|deploy\|rollback\|harden\|targets\|domain\|registry\|prune\|audit\|snapshot\|accessory\|app>/,
    );
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

  it('deploy on the kamal engine rejects --write (it generates no files)', async () => {
    const dir = makeDir('write-deploy');
    const s = sinks();

    const code = await runJamalCommand(['deploy', '--write'], deps(dir, s));

    assert.equal(code, 2, s.err.join('\n'));
    assert.deepEqual(listFiles(dir), []);
    assert.match(s.err.join('\n'), /--write is not valid/);
  });

  it('maps dev and harden subcommands to exactly their registry generators', async () => {
    const dir = makeDir('stub');
    const registry = createDeploymentGeneratorRegistry({
      includeBuiltins: false,
      generators: [
        defineDeploymentGenerator('valkey-dev', () => ({
          files: { 'dev/valkey.txt': 'v' },
        })),
        defineDeploymentGenerator('database-dev', () => ({
          files: { 'dev/db.txt': 'd' },
        })),
        defineDeploymentGenerator('harden-server', () => ({
          files: { 'prod/harden.txt': 'h' },
        })),
      ],
    });
    const s = sinks();
    const d = deps(dir, s, () => registry);

    assert.equal(await runJamalCommand(['dev', '--write'], d), 0);
    assert.deepEqual(listFiles(dir), ['dev/db.txt', 'dev/valkey.txt'].sort());

    assert.equal(await runJamalCommand(['harden', '--write'], d), 0);
    assert.deepEqual(listFiles(dir), ['dev/db.txt', 'dev/valkey.txt', 'prod/harden.txt'].sort());
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
  it('rejects a static target without --write as a usage error', async () => {
    const dir = makeDir('target-no-write');
    const s = sinks();

    const code = await runJamalCommand(['deploy', '--target', 'vercel'], deps(dir, s));

    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /--write/);
    assert.deepEqual(listFiles(dir), []);
  });

  it('vercel --write produces exactly vercel.json', async () => {
    const dir = makeDir('write-vercel');
    const s = sinks();
    const invoked: string[][] = [];
    const code = await runJamalCommand(
      ['deploy', '--target', 'vercel', '--write'],
      deps(dir, s, undefined, undefined, undefined, async (argv) => {
        invoked.push([...argv]);
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    );

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(listFiles(dir), ['vercel.json']);
    assert.match(s.out.join('\n'), /wrote 1 file\(s\), skipped 0/);
    assert.deepEqual(invoked, [['npx', '--yes', 'vercel', 'deploy', '--prod']]);
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
    const invoked: string[][] = [];
    const code = await runJamalCommand(
      ['deploy', '--target', 'cloudflare', '--write'],
      deps(dir, s, undefined, undefined, undefined, async (argv) => {
        invoked.push([...argv]);
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    );

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(listFiles(dir), ['wrangler.toml']);
    assert.deepEqual(invoked, [['npx', '--yes', 'wrangler', 'pages', 'deploy', 'out']]);
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
        defineDeploymentGenerator('vercel-static', () => ({
          files: { 'v/vercel.txt': 'v' },
        })),
        defineDeploymentGenerator('netlify-static', () => ({
          files: { 'n/netlify.txt': 'n' },
        })),
        defineDeploymentGenerator('cloudflare-pages', () => ({
          files: { 'c/wrangler.txt': 'c' },
        })),
        defineDeploymentGenerator('github-pages', () => ({
          files: { 'g/workflow.txt': 'g' },
        })),
      ],
    });
    const s = sinks();
    const invoked: string[][] = [];
    const d = deps(
      dir,
      s,
      () => registry,
      undefined,
      undefined,
      async (argv) => {
        invoked.push([...argv]);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    );

    assert.equal(await runJamalCommand(['deploy', '--target', 'vercel', '--write'], d), 0);
    assert.deepEqual(listFiles(dir), ['v/vercel.txt']);
    assert.deepEqual(invoked.at(-1), ['npx', '--yes', 'vercel', 'deploy', '--prod']);

    assert.equal(await runJamalCommand(['deploy', '--target', 'netlify', '--write'], d), 0);
    assert.deepEqual(listFiles(dir), ['n/netlify.txt', 'v/vercel.txt'].sort());
    assert.deepEqual(invoked.at(-1), ['npx', '--yes', 'netlify', 'deploy', '--prod']);

    assert.equal(await runJamalCommand(['deploy', '--target', 'cloudflare', '--write'], d), 0);
    assert.deepEqual(listFiles(dir), ['c/wrangler.txt', 'n/netlify.txt', 'v/vercel.txt'].sort());
    assert.deepEqual(invoked.at(-1), ['npx', '--yes', 'wrangler', 'pages', 'deploy', 'out']);

    assert.equal(await runJamalCommand(['deploy', '--target', 'github', '--write'], d), 0);
    assert.deepEqual(
      listFiles(dir),
      ['c/wrangler.txt', 'g/workflow.txt', 'n/netlify.txt', 'v/vercel.txt'].sort(),
    );
    assert.deepEqual(invoked.length, 3, 'github must not spawn a CLI (push-based)');
  });

  it('--dry-run on a static target generates without executing', async () => {
    const dir = makeDir('target-dryrun');
    const s = sinks();
    let ran = false;
    const d = deps(dir, s, undefined, undefined, undefined, async () => {
      ran = true;
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const code = await runJamalCommand(['deploy', '--target', 'vercel', '--write', '--dry-run'], d);

    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(ran, false, '--dry-run must not execute the npx deploy');
    assert.deepEqual(listFiles(dir), ['vercel.json']);
  });
});

describe('jamal: removed TLS/hardening flags', () => {
  it('rejects --on-demand-tls as an unknown option', async () => {
    const dir = makeDir('tls-removed');
    const s = sinks();

    const code = await runJamalCommand(
      ['deploy', '--on-demand-tls', 'https://tls.example.com/check'],
      deps(dir, s),
    );

    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /Unknown option '--on-demand-tls'/);
    assert.deepEqual(listFiles(dir), []);
  });

  it('rejects --no-harden as an unknown option', async () => {
    const dir = makeDir('harden-removed');
    const s = sinks();

    const code = await runJamalCommand(['deploy', '--no-harden'], deps(dir, s));

    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /Unknown option '--no-harden'/);
    assert.deepEqual(listFiles(dir), []);
  });
});

describe('jamal: harden', () => {
  it('dry-run writes nothing, lists the script, and prints the review reminder', async () => {
    const dir = makeDir('harden-dry');
    const s = sinks();

    const code = await runJamalCommand(['harden'], deps(dir, s));

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(listFiles(dir), []);
    const out = s.out.join('\n');
    assert.match(out, /nothing written/);
    assert.ok(out.includes('  config/harden-server.sh'));
    assert.match(out, /Jamal never runs it/);
    assert.match(out, /a human must run it by hand/);
    assert.match(out, /sudo sh config\/harden-server\.sh/);
  });

  it('--write materializes exactly config/harden-server.sh and prints the reminder', async () => {
    const dir = makeDir('harden-write');
    const s = sinks();

    const code = await runJamalCommand(['harden', '--write'], deps(dir, s));

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(listFiles(dir), ['config/harden-server.sh']);
    assert.match(s.out.join('\n'), /wrote 1 file\(s\), skipped 0/);
    assert.match(s.out.join('\n'), /Jamal never runs it/);
    const content = readFileSync(join(dir, 'config/harden-server.sh'), 'utf8');
    assert.match(content, /ufw default deny incoming/);
    assert.match(content, /ufw --force enable/);
  });

  it('writes into a chosen --dir', async () => {
    const dir = makeDir('harden-dir');
    const s = sinks();

    const code = await runJamalCommand(['harden', '--write', '--dir', 'deploy'], deps(dir, s));

    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(existsSync(join(dir, 'deploy', 'config/harden-server.sh')), true);
    assert.equal(existsSync(join(dir, 'config/harden-server.sh')), false);
  });
});

describe('jamal: custom deployments', () => {
  it('writes a custom deployment target from the config (requires --write)', async () => {
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

    assert.equal(code, 2);
    assert.deepEqual(listFiles(dir), []);
    // The generator runs once to build the plan before the --write gate rejects.
    assert.equal(ran, 1);

    const written = await runJamalCommand(['deploy', '--target', 'cdn', '--write'], d);

    assert.equal(written, 0, s.err.join('\n'));
    assert.deepEqual(listFiles(dir), ['cdn.txt']);
    assert.equal(ran, 2);
    assert.match(s.out.join('\n'), /wrote 1 file\(s\), skipped 0/);
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

    const code = await runJamalCommand(['deploy', '--target', 'vercel', '--write'], d);

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

describe('jamal: managed compose (up/exec)', () => {
  it('up materializes .jamal/compose.yml and runs the managed argv', async () => {
    const dir = makeDir('up-managed');
    const s = sinks();
    const r = recordingRunner();
    const load = async () => fakeJamalConfig();

    const code = await runJamalCommand(['up'], deps(dir, s, undefined, undefined, load, r.run));

    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.calls[0]?.argv, [
      'docker',
      'compose',
      '-f',
      '.jamal/compose.yml',
      '-p',
      'myapp',
      'up',
      '-d',
      '--wait',
    ]);
    assert.equal(r.calls[0]?.cwd, dir);
    assert.equal(existsSync(join(dir, '.jamal', 'compose.yml')), true);
    assert.match(readFileSync(join(dir, '.jamal', 'compose.yml'), 'utf8'), /name: myapp/);
  });

  it('up reports a clear, value-free error when jamal.config.js is missing', async () => {
    const dir = makeDir('up-no-config');
    const s = sinks();
    const r = recordingRunner();

    const code = await runJamalCommand(
      ['up'],
      deps(dir, s, undefined, undefined, undefined, r.run),
    );

    assert.equal(code, 1);
    assert.equal(r.calls.length, 0);
    const err = s.err.join('\n');
    assert.match(err, /jamal\.config\.js/);
    assert.match(err, /not found/);
    assert.ok(!err.includes('\n    at '), 'no stack trace may leak');
  });

  it('exec requires the -- separator', async () => {
    const dir = makeDir('exec-no-sep');
    const s = sinks();

    const code = await runJamalCommand(['exec', 'valkey', 'sh'], deps(dir, s));

    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /requires "--"/);
  });

  it('exec requires the managed compose file', async () => {
    const dir = makeDir('exec-no-file');
    const s = sinks();

    const code = await runJamalCommand(['exec', 'valkey', '--', 'sh', '-c', 'echo'], deps(dir, s));

    assert.equal(code, 1);
    const err = s.err.join('\n');
    assert.match(err, /\.jamal\/compose\.yml/);
    assert.match(err, /jamal up/);
  });

  it('exec wires the service and command into the managed exec argv', async () => {
    const dir = makeDir('exec-managed');
    mkdirSync(join(dir, '.jamal'), { recursive: true });
    writeFileSync(join(dir, '.jamal', 'compose.yml'), 'name: myapp\n');
    const s = sinks();
    const r = recordingRunner();
    const load = async () => fakeJamalConfig();

    const code = await runJamalCommand(
      ['exec', 'valkey', '--', 'sh', '-c', 'echo hi'],
      deps(dir, s, undefined, undefined, load, r.run),
    );

    assert.equal(code, 0, s.err.join('\n'));
    assert.deepEqual(r.calls[0]?.argv, [
      'docker',
      'compose',
      '-f',
      '.jamal/compose.yml',
      '-p',
      'myapp',
      'exec',
      'valkey',
      '--',
      'sh',
      '-c',
      'echo hi',
    ]);
    assert.equal(r.calls[0]?.cwd, dir);
  });

  it('down/ps/logs use the managed file and project when it exists', async () => {
    const dir = makeDir('managed-fallback');
    mkdirSync(join(dir, '.jamal'), { recursive: true });
    writeFileSync(join(dir, '.jamal', 'compose.yml'), 'name: myapp\n');
    const s = sinks();
    const load = async () => fakeJamalConfig();

    const down = recordingRunner();
    assert.equal(
      await runJamalCommand(['down'], deps(dir, s, undefined, undefined, load, down.run)),
      0,
    );
    assert.deepEqual(down.calls[0]?.argv, [
      'docker',
      'compose',
      '-f',
      '.jamal/compose.yml',
      '-p',
      'myapp',
      'down',
    ]);

    const ps = recordingRunner();
    assert.equal(
      await runJamalCommand(['ps'], deps(dir, s, undefined, undefined, load, ps.run)),
      0,
    );
    assert.deepEqual(ps.calls[0]?.argv, [
      'docker',
      'compose',
      '-f',
      '.jamal/compose.yml',
      '-p',
      'myapp',
      'ps',
    ]);
  });
});

describe('jamal: registry', () => {
  it('prints the docker login argv for the production registry', async () => {
    const dir = makeDir('registry-login');
    const s = sinks();
    const load = async () =>
      normalizeJamalConfig({
        service: 'myapp',
        image: 'ghcr.io/acme/myapp:latest',
        production: {
          server: 'host.example.com',
          registry: { server: 'ghcr.io', username: 'mybot' },
        },
      });

    const code = await runJamalCommand(['registry'], deps(dir, s, undefined, undefined, load));

    assert.equal(code, 0, s.err.join('\n'));
    const out = s.out.join('\n');
    assert.match(out, /Registry: ghcr.io/);
    assert.match(out, /Username: mybot/);
    assert.match(out, /secret\(JSAILS_REGISTRY_PASSWORD\)/);
    assert.match(out, /docker login ghcr.io -u mybot -p secret/);
  });

  it('reports an error when no registry is configured', async () => {
    const dir = makeDir('registry-no-cfg');
    const s = sinks();
    const load = async () =>
      normalizeJamalConfig({
        service: 'myapp',
        image: 'ghcr.io/acme/myapp:latest',
        production: { server: 'host.example.com' },
      });

    const code = await runJamalCommand(['registry'], deps(dir, s, undefined, undefined, load));

    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /production registry is required/);
  });
});

describe('jamal: prune', () => {
  it('prints the prune plan for a given image list', async () => {
    const dir = makeDir('prune-plan');
    const s = sinks();

    const code = await runJamalCommand(
      ['prune', '--keep', '2', '--images', 'myapp:a', '--images', 'myapp:b', '--images', 'myapp:c'],
      deps(dir, s),
    );

    assert.equal(code, 0, s.err.join('\n'));
    const out = s.out.join('\n');
    assert.match(out, /1 image\(s\) to remove/);
    assert.match(out, /myapp:c/);
    assert.match(out, /Kept 2 image/);
  });

  it('requires --keep', async () => {
    const dir = makeDir('prune-no-keep');
    const s = sinks();

    const code = await runJamalCommand(['prune'], deps(dir, s));

    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /--keep/);
  });

  it('rejects --keep < 1', async () => {
    const dir = makeDir('prune-bad-keep');
    const s = sinks();

    const code = await runJamalCommand(['prune', '--keep', '0'], deps(dir, s));

    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /--keep must be a positive integer/);
  });

  it('prints "No images to prune" when --images is empty', async () => {
    const dir = makeDir('prune-empty');
    const s = sinks();

    const code = await runJamalCommand(['prune', '--keep', '3'], deps(dir, s));

    assert.equal(code, 0);
    assert.match(s.out.join('\n'), /No images to prune/);
  });
});

describe('jamal: audit', () => {
  it('prints a security checklist', async () => {
    const dir = makeDir('audit-checklist');
    const s = sinks();
    const load = async () =>
      normalizeJamalConfig({
        service: 'myapp',
        image: 'ghcr.io/acme/myapp:latest',
        production: { server: 'host.example.com' },
        env: { KEY: 'value' },
      });

    const code = await runJamalCommand(['audit'], deps(dir, s, undefined, undefined, load));

    assert.equal(code, 0, s.err.join('\n'));
    const out = s.out.join('\n');
    assert.match(out, /\[ERROR\]/);
    assert.match(out, /\[WARN /);
    assert.match(out, /No registry configured/);
  });

  it('prints "No findings" for a clean config', async () => {
    const dir = makeDir('audit-clean');
    const s = sinks();
    const load = async () =>
      normalizeJamalConfig({
        service: 'myapp',
        image: 'ghcr.io/acme/myapp:latest',
        production: {
          server: 'host.example.com',
          domain: 'example.com',
          registry: { server: 'ghcr.io', username: 'bot' },
        },
        health: { path: '/healthz', timeoutMs: 5000, intervalMs: 1000 },
        volumes: { data: '/var/lib/data' },
      });

    // All still has the "no production config" finding... wait, production IS present.
    const code = await runJamalCommand(['audit'], deps(dir, s, undefined, undefined, load));

    assert.equal(code, 0, s.err.join('\n'));
    // With production + domain + registry + health + bind-mounted volumes,
    // there should be no findings.
    assert.match(s.out.join('\n'), /No findings/);
  });
});

describe('jamal: snapshot', () => {
  it('prints the dump argv for a mariadb service', async () => {
    const dir = makeDir('snapshot-dump');
    const s = sinks();

    const code = await runJamalCommand(['snapshot', 'db', '--name', 'test'], deps(dir, s));

    assert.equal(code, 0, s.err.join('\n'));
    const out = s.out.join('\n');
    assert.match(out, /Operation: snapshot db ->/);
    assert.match(out, /docker compose exec -T db/);
    assert.match(out, /mariadb-dump/);
  });

  it('prints the restore argv', async () => {
    const dir = makeDir('snapshot-restore');
    const s = sinks();

    const code = await runJamalCommand(
      ['snapshot', 'restore', 'db', '--snapshot', '/tmp/dump.sql.gz', '--driver', 'postgres'],
      deps(dir, s),
    );

    assert.equal(code, 0, s.err.join('\n'));
    const out = s.out.join('\n');
    assert.match(out, /Operation: restore db <-/);
    assert.match(out, /docker compose exec -T db/);
    assert.match(out, /psql/);
  });

  it('requires a service name for dump', async () => {
    const dir = makeDir('snapshot-no-svc');
    const s = sinks();

    const code = await runJamalCommand(['snapshot'], deps(dir, s));

    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /service name/);
  });

  it('requires --snapshot for restore', async () => {
    const dir = makeDir('snapshot-no-path');
    const s = sinks();

    const code = await runJamalCommand(['snapshot', 'restore', 'db'], deps(dir, s));

    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /--snapshot/);
  });
});
