import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  checkPlugins,
  readFrameworkVersion,
  type CheckPluginsResult,
} from '../../src/plugins/check.js';
import type {
  DiscoveredPlugin,
  DiscoverPluginsResult,
  PluginIssue,
} from '../../src/plugins/discovery.js';
import type { PluginSource } from '../../src/plugins/provenance.js';

const FRAMEWORK_VERSION = '0.1.0';

/** A declared plugin-to-plugin dependency range. */
interface DeclaredDependency {
  readonly id: string;
  readonly range: string;
}

/** A discovered plugin fixture with a full manifest. */
function discovered(
  id: string,
  version: string,
  jsailsCompat: string,
  source: PluginSource = 'dependency',
  plugins?: readonly DeclaredDependency[],
): DiscoveredPlugin {
  return {
    id,
    version,
    source,
    manifestPath: `/virtual/${id}/package.json`,
    manifest: {
      id,
      version,
      jsailsCompat,
      permissions: [],
      entry: './index.js',
      ...(plugins === undefined ? {} : { plugins }),
    },
    ...(source === 'dependency' ? { packageName: id } : { bundleDir: `/virtual/${id}` }),
  };
}

function result(
  plugins: readonly DiscoveredPlugin[],
  issues: readonly PluginIssue[] = [],
): DiscoverPluginsResult {
  return { plugins, issues };
}

describe('checkPlugins', () => {
  it('passes a plugin whose jsailsCompat includes the framework version', () => {
    const checked = checkPlugins(
      result([discovered('acme', '1.0.0', '^0.1.0')]),
      FRAMEWORK_VERSION,
    );
    assert.equal(checked.ok, true);
    assert.equal(checked.findings.length, 0);
    assert.equal(checked.frameworkVersion, FRAMEWORK_VERSION);
  });

  it('flags an incompatible plugin', () => {
    const checked = checkPlugins(
      result([discovered('acme', '2.0.0', '^1.0.0')]),
      FRAMEWORK_VERSION,
    );
    assert.equal(checked.ok, false);
    assert.equal(checked.findings.length, 1);
    const finding = checked.findings[0]!;
    assert.equal(finding.kind, 'incompatible');
    assert.equal(finding.pluginId, 'acme');
  });

  it('promotes discovery issues into malformed findings', () => {
    const issue: PluginIssue = {
      source: 'dependency',
      code: 'dependency_missing',
      message: 'dependency "foo" is not installed',
      path: '/virtual/foo',
    };
    const checked = checkPlugins(result([], [issue]), FRAMEWORK_VERSION);
    assert.equal(checked.ok, false);
    assert.equal(checked.findings[0]!.kind, 'malformed');
    assert.equal(checked.findings[0]!.code, 'dependency_missing');
  });

  it('flags multiple versions of the same id as a duplicate', () => {
    const checked = checkPlugins(
      result([discovered('acme', '1.0.0', '^0.1.0'), discovered('acme', '2.0.0', '^0.1.0')]),
      FRAMEWORK_VERSION,
    );
    assert.equal(checked.ok, false);
    const duplicate = checked.findings.find((f) => f.kind === 'duplicate');
    assert.ok(duplicate);
    assert.equal(duplicate.pluginId, 'acme');
  });

  it('reports every failure category together', () => {
    const checked: CheckPluginsResult = checkPlugins(
      result(
        [
          discovered('acme', '1.0.0', '^0.1.0'),
          discovered('acme', '2.0.0', '^0.1.0'),
          discovered('old', '1.0.0', '^2.0.0'),
        ],
        [
          {
            source: 'bundle',
            code: 'invalid_manifest',
            message: 'bad',
            path: '/x',
          },
        ],
      ),
      FRAMEWORK_VERSION,
    );
    assert.equal(checked.ok, false);
    const kinds = checked.findings.map((f) => f.kind).sort();
    assert.deepEqual(kinds, ['duplicate', 'incompatible', 'malformed']);
  });
});

describe('checkPlugins graph issue codes', () => {
  it('maps the four graph issue codes to their dedicated finding kinds', () => {
    const issues: PluginIssue[] = [
      {
        source: 'dependency',
        code: 'dependency_cycle',
        message: 'cycle',
        pluginId: 'a',
      },
      {
        source: 'dependency',
        code: 'conflicting_plugin_versions',
        message: 'conflict',
        pluginId: 'b',
      },
      {
        source: 'dependency',
        code: 'disabled_required_plugin',
        message: 'disabled',
        pluginId: 'c',
      },
      {
        source: 'dependency',
        code: 'transitive_dependency_missing',
        message: 'missing',
        path: '/x',
      },
    ];
    const checked = checkPlugins(result([], issues), FRAMEWORK_VERSION);
    assert.equal(checked.ok, false);

    const byCode = new Map(checked.findings.map((f) => [f.code, f]));
    assert.equal(byCode.get('dependency_cycle')!.kind, 'cycle');
    assert.equal(byCode.get('conflicting_plugin_versions')!.kind, 'conflict');
    assert.equal(byCode.get('disabled_required_plugin')!.kind, 'disabled');
    assert.equal(byCode.get('transitive_dependency_missing')!.kind, 'missing');
  });
});

describe('checkPlugins declared dependencies', () => {
  it('flags an unsatisfied declared dependency range', () => {
    const acme = discovered('acme', '1.0.0', '^0.1.0', 'dependency', [
      { id: 'other', range: '^2.0.0' },
    ]);
    const other = discovered('other', '1.0.0', '^0.1.0');
    const checked = checkPlugins(result([acme, other]), FRAMEWORK_VERSION);
    assert.equal(checked.ok, false);

    const finding = checked.findings.find((f) => f.code === 'unsatisfied_dependency');
    assert.ok(finding);
    assert.equal(finding.kind, 'conflict');
    assert.equal(finding.pluginId, 'acme');
  });

  it('flags a declared dependency whose id is not discovered', () => {
    const acme = discovered('acme', '1.0.0', '^0.1.0', 'dependency', [
      { id: 'ghost', range: '^1.0.0' },
    ]);
    const checked = checkPlugins(result([acme]), FRAMEWORK_VERSION);
    assert.equal(checked.ok, false);

    const finding = checked.findings.find((f) => f.code === 'missing_dependency');
    assert.ok(finding);
    assert.equal(finding.kind, 'missing');
    assert.equal(finding.pluginId, 'acme');
  });

  it('accepts a declared dependency satisfied by a discovered version', () => {
    const acme = discovered('acme', '1.0.0', '^0.1.0', 'dependency', [
      { id: 'other', range: '^1.0.0' },
    ]);
    const other = discovered('other', '1.5.0', '^0.1.0');
    const checked = checkPlugins(result([acme, other]), FRAMEWORK_VERSION);
    assert.equal(checked.ok, true);
    assert.equal(checked.findings.length, 0);
  });

  it('skips a declared dependency with a non-semver spec', () => {
    const acme = discovered('acme', '1.0.0', '^0.1.0', 'dependency', [
      { id: 'file-dep', range: 'file:../file-dep' },
      { id: 'ws-dep', range: 'workspace:*' },
      { id: 'git-dep', range: 'git+https://example.com/repo.git' },
    ]);
    const checked = checkPlugins(result([acme]), FRAMEWORK_VERSION);
    assert.equal(checked.ok, true);
    assert.equal(checked.findings.length, 0);
  });
});

describe('readFrameworkVersion', () => {
  const fixturesRoot = mkdtempSync(join(tmpdir(), 'plugins-check-'));

  after(() => {
    rmSync(fixturesRoot, { recursive: true, force: true });
  });

  it('reads the version from an explicit package.json path', () => {
    const path = join(fixturesRoot, 'package.json');
    writeFileSync(path, JSON.stringify({ name: 'jsails', version: '9.8.7' }), 'utf8');
    assert.equal(readFrameworkVersion(path), '9.8.7');
  });

  it('throws a value-free error for a missing package.json', () => {
    const path = join(fixturesRoot, 'nope', 'package.json');
    assert.throws(() => readFrameworkVersion(path), /framework package.json/);
  });

  it('throws when the package.json has no version', () => {
    const path = join(fixturesRoot, 'no-version.json');
    writeFileSync(path, JSON.stringify({ name: 'jsails' }), 'utf8');
    assert.throws(() => readFrameworkVersion(path), /no version/);
  });
});
