import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { runPluginsCommand, type PluginsDeps } from '../../src/cli/plugins-command.js';

interface Sinks {
  out: string[];
  err: string[];
}

function sinks(): Sinks {
  return { out: [], err: [] };
}

function deps(cwd: string, s: Sinks): PluginsDeps {
  return {
    cwd,
    frameworkVersion: '0.1.0',
    stdout: (text) => s.out.push(text),
    stderr: (text) => s.err.push(text),
  };
}

const fixturesRoot = mkdtempSync(join(tmpdir(), 'plugins-command-'));

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function manifest(id: string, version: string, jsailsCompat: string): Record<string, unknown> {
  return { id, version, jsailsCompat, entry: './index.js' };
}

/** A root plugin whose package.json requires one transitive plugin package. */
function writeChain(root: string): void {
  writeJson(join(root, 'package.json'), {
    dependencies: { 'parent-plugin': '^1.0.0' },
  });
  writeJson(join(root, 'node_modules', 'parent-plugin', 'package.json'), {
    name: 'parent-plugin',
    version: '1.0.0',
    dependencies: { 'child-plugin': '^1.0.0' },
    jsails: manifest('parent', '1.0.0', '^0.1.0'),
  });
  writeJson(join(root, 'node_modules', 'child-plugin', 'package.json'), {
    name: 'child-plugin',
    version: '1.0.0',
    jsails: manifest('child', '1.0.0', '^0.1.0'),
  });
}

describe('runPluginsCommand list', () => {
  it('lists discovered plugins as a human table', async () => {
    const root = join(fixturesRoot, 'list-human');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'my-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'my-plugin', 'package.json'), {
      name: 'my-plugin',
      jsails: manifest('acme', '1.0.0', '^0.1.0'),
    });

    const s = sinks();
    const code = await runPluginsCommand([], deps(root, s));
    assert.equal(code, 0);
    assert.match(s.out.join('\n'), /1 plugin\(s\) discovered/);
    assert.match(s.out.join('\n'), /acme@1\.0\.0 \[dependency\]/);
  });

  it('emits JSON for --json', async () => {
    const root = join(fixturesRoot, 'list-json');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'my-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'my-plugin', 'package.json'), {
      name: 'my-plugin',
      jsails: manifest('acme', '1.0.0', '^0.1.0'),
    });

    const s = sinks();
    const code = await runPluginsCommand(['--json'], deps(root, s));
    assert.equal(code, 0);
    const parsed = JSON.parse(s.out[0]!) as {
      plugins: Array<{ id: string; source: string }>;
    };
    assert.equal(parsed.plugins.length, 1);
    assert.equal(parsed.plugins[0]!.id, 'acme');
    assert.equal(parsed.plugins[0]!.source, 'dependency');
  });

  it('prints discovery warnings to stderr without failing', async () => {
    const root = join(fixturesRoot, 'list-warning');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'my-plugin': '^1.0.0' },
    });

    const s = sinks();
    const code = await runPluginsCommand([], deps(root, s));
    assert.equal(code, 0);
    assert.match(s.err.join('\n'), /not installed/);
  });

  it('defaults to <cwd>/storage/plugins for bundles', async () => {
    const root = join(fixturesRoot, 'list-bundle');
    writeJson(
      join(root, 'storage', 'plugins', 'acme', 'manifest.json'),
      manifest('acme', '1.0.0', '^0.1.0'),
    );

    const s = sinks();
    const code = await runPluginsCommand([], deps(root, s));
    assert.equal(code, 0);
    assert.match(s.out.join('\n'), /acme@1\.0\.0 \[bundle\]/);
  });

  it('shows root provenance and requiredBy for a transitive plugin', async () => {
    const root = join(fixturesRoot, 'list-provenance');
    writeChain(root);

    const s = sinks();
    const code = await runPluginsCommand([], deps(root, s));
    assert.equal(code, 0);
    const out = s.out.join('\n');
    assert.match(out, /parent@1\.0\.0 \[dependency\] root/);
    assert.match(out, /child@1\.0\.0 \[dependency\] dependency required by: parent/);
  });

  it('emits root/requiredBy/provenanceChain/edges in --json', async () => {
    const root = join(fixturesRoot, 'list-json-provenance');
    writeChain(root);

    const s = sinks();
    const code = await runPluginsCommand(['--json'], deps(root, s));
    assert.equal(code, 0);
    const parsed = JSON.parse(s.out[0]!) as {
      plugins: Array<{
        id: string;
        root?: boolean;
        requiredBy?: string[];
        provenanceChain?: string[];
      }>;
      edges?: string[];
    };

    const parent = parsed.plugins.find((p) => p.id === 'parent')!;
    const child = parsed.plugins.find((p) => p.id === 'child')!;

    assert.equal(parent.root, true);
    assert.equal(parent.requiredBy, undefined);
    assert.deepEqual(parent.provenanceChain, ['parent']);

    assert.equal(child.root, false);
    assert.deepEqual(child.requiredBy, ['parent']);
    assert.deepEqual(child.provenanceChain, ['child', 'parent']);

    assert.deepEqual(parsed.edges, ['parent -> child']);
  });
});

describe('runPluginsCommand check', () => {
  it('exits 0 when all plugins are compatible', async () => {
    const root = join(fixturesRoot, 'check-ok');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'my-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'my-plugin', 'package.json'), {
      name: 'my-plugin',
      jsails: manifest('acme', '1.0.0', '^0.1.0'),
    });

    const s = sinks();
    const code = await runPluginsCommand(['check'], deps(root, s));
    assert.equal(code, 0);
    assert.match(s.out.join('\n'), /0 finding\(s\)/);
  });

  it('exits 1 on an incompatible plugin and emits a finding', async () => {
    const root = join(fixturesRoot, 'check-bad');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'my-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'my-plugin', 'package.json'), {
      name: 'my-plugin',
      jsails: manifest('acme', '2.0.0', '^1.0.0'),
    });

    const s = sinks();
    const code = await runPluginsCommand(['check'], deps(root, s));
    assert.equal(code, 1);
    assert.match(s.out.join('\n'), /incompatible/);
  });

  it('emits JSON for check --json', async () => {
    const root = join(fixturesRoot, 'check-json');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'my-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'my-plugin', 'package.json'), {
      name: 'my-plugin',
      jsails: manifest('acme', '2.0.0', '^1.0.0'),
    });

    const s = sinks();
    const code = await runPluginsCommand(['check', '--json'], deps(root, s));
    assert.equal(code, 1);
    const parsed = JSON.parse(s.out[0]!) as {
      ok: boolean;
      frameworkVersion: string;
    };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.frameworkVersion, '0.1.0');
  });

  it('exits 1 and surfaces a graph issue as a dedicated finding kind', async () => {
    const root = join(fixturesRoot, 'check-graph-issue');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'parent-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'parent-plugin', 'package.json'), {
      name: 'parent-plugin',
      version: '1.0.0',
      dependencies: { 'missing-plugin': '^1.0.0' },
      jsails: manifest('parent', '1.0.0', '^0.1.0'),
    });

    const s = sinks();
    const code = await runPluginsCommand(['check'], deps(root, s));
    assert.equal(code, 1);
    assert.match(s.out.join('\n'), /missing\s+transitive dependency/);
  });
});

describe('runPluginsCommand usage and safety', () => {
  it('prints help and exits 0 for --help', async () => {
    const root = join(fixturesRoot, 'help');
    const s = sinks();
    const code = await runPluginsCommand(['--help'], deps(root, s));
    assert.equal(code, 0);
    assert.match(s.out.join('\n'), /Usage:/);
  });

  it('rejects an unknown subcommand with exit 2', async () => {
    const root = join(fixturesRoot, 'unknown');
    const s = sinks();
    const code = await runPluginsCommand(['nope'], deps(root, s));
    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /unknown subcommand/);
  });

  it('rejects a --dir that escapes cwd with exit 1', async () => {
    const root = join(fixturesRoot, 'escape');
    mkdirSync(root, { recursive: true });
    const s = sinks();
    const code = await runPluginsCommand(['--dir', '../outside'], deps(root, s));
    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /escapes the working directory/);
  });

  it('honors an explicit --dir', async () => {
    const root = join(fixturesRoot, 'dir');
    writeJson(join(root, 'custom', 'acme', 'manifest.json'), manifest('acme', '1.0.0', '^0.1.0'));

    const s = sinks();
    const code = await runPluginsCommand(['--dir', 'custom'], deps(root, s));
    assert.equal(code, 0);
    assert.match(s.out.join('\n'), /acme@1\.0\.0 \[bundle\]/);
  });
});
