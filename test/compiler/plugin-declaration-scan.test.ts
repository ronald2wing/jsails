import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { scanPluginDeclarations } from '../../src/compiler/plugin-declaration-scan.js';

describe('scanPluginDeclarations', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'plugin-decl-scans-'));
  let seq = 0;

  after(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function root(): string {
    const dir = join(fixtureRoot, `case-${seq++}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function writeDeclaration(rootDir: string, plugin: string, content: string): void {
    const file = join(rootDir, 'src', plugin, 'jsails.plugin.json');
    mkdirSync(join(rootDir, 'src', plugin), { recursive: true });
    writeFileSync(file, `${content}\n`);
  }

  it('discovers first-party plugin declarations under src/', () => {
    const rootDir = root();
    writeDeclaration(
      rootDir,
      'auth',
      JSON.stringify({ id: 'jsails-auth', provides: ['jsails/auth'] }),
    );

    const found = scanPluginDeclarations({ frameworkRootDir: rootDir });
    assert.equal(found.length, 1);
    assert.equal(found[0]!.id, 'jsails-auth');
    assert.deepEqual(found[0]!.declaration.provides, ['jsails/auth']);
  });

  it('falls back to dist/src when no src/ exists', () => {
    const rootDir = root();
    // No `src/` → declaration mode reads `dist/src/`.
    const file = join(rootDir, 'dist', 'src', 'blog', 'jsails.plugin.json');
    mkdirSync(join(rootDir, 'dist', 'src', 'blog'), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ id: 'jsails-blog', provides: ['jsails/blog'] })}\n`);

    const found = scanPluginDeclarations({ frameworkRootDir: rootDir });
    assert.equal(found.length, 1);
    assert.equal(found[0]!.id, 'jsails-blog');
  });

  it('is a silent no-op when no declarations exist', () => {
    const rootDir = root();
    const found = scanPluginDeclarations({ frameworkRootDir: rootDir });
    assert.deepEqual(found, []);
  });

  it('sorts by id deterministically', () => {
    const rootDir = root();
    writeDeclaration(rootDir, 'blog', JSON.stringify({ id: 'jsails-blog' }));
    writeDeclaration(rootDir, 'auth', JSON.stringify({ id: 'jsails-auth' }));

    const found = scanPluginDeclarations({ frameworkRootDir: rootDir });
    assert.deepEqual(
      found.map((f) => f.id),
      ['jsails-auth', 'jsails-blog'],
    );
  });

  it('parses an extra third-party declaration path', () => {
    const rootDir = root();
    const extraFile = join(rootDir, 'third-party', 'jsails.plugin.json');
    mkdirSync(join(rootDir, 'third-party'), { recursive: true });
    writeFileSync(
      extraFile,
      `${JSON.stringify({ id: 'acme-search', provides: ['acme-search'] })}\n`,
    );

    const found = scanPluginDeclarations({ frameworkRootDir: rootDir, extra: [extraFile] });
    assert.equal(found.length, 1);
    assert.equal(found[0]!.id, 'acme-search');
  });
});
