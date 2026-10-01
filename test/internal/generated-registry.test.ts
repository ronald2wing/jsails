import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, describe, it } from 'node:test';

import { importGeneratedRegistry } from '../../src/internal/generated-registry.js';

const createdDirs: string[] = [];

after(() => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-genreg-'));
  createdDirs.push(dir);
  return dir;
}

/** Write a registry module that records its import on `globalThis`. */
function writeRegistry(path: string, marker: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `globalThis.${marker} = (globalThis.${marker} ?? 0) + 1;\n`);
}

describe('importGeneratedRegistry', () => {
  it('imports the compiled dist/.jsails registry when present', async () => {
    const root = makeRoot();
    const marker = `__genreg_dist_${Date.now()}`;
    writeRegistry(join(root, 'dist', '.jsails', 'models.registry.js'), marker);

    const found = await importGeneratedRegistry('models.registry', { rootDir: root });

    assert.equal(found, true);
    assert.equal((globalThis as Record<string, unknown>)[marker], 1);
  });

  it('falls back to a colocated .jsails registry (from-source run)', async () => {
    const root = makeRoot();
    const marker = `__genreg_src_${Date.now()}`;
    writeRegistry(join(root, '.jsails', 'components.registry.js'), marker);

    const found = await importGeneratedRegistry('components.registry', { rootDir: root });

    assert.equal(found, true);
    assert.equal((globalThis as Record<string, unknown>)[marker], 1);
  });

  it('prefers dist/.jsails over a colocated .jsails registry', async () => {
    const root = makeRoot();
    const distMarker = `__genreg_pref_dist_${Date.now()}`;
    const srcMarker = `__genreg_pref_src_${Date.now()}`;
    writeRegistry(join(root, 'dist', '.jsails', 'models.registry.js'), distMarker);
    writeRegistry(join(root, '.jsails', 'models.registry.js'), srcMarker);

    await importGeneratedRegistry('models.registry', { rootDir: root });

    assert.equal((globalThis as Record<string, unknown>)[distMarker], 1);
    assert.equal((globalThis as Record<string, unknown>)[srcMarker], undefined);
  });

  it('returns false when no registry exists (silent no-op)', async () => {
    const root = makeRoot();
    const found = await importGeneratedRegistry('models.registry', { rootDir: root });
    assert.equal(found, false);
  });

  it('honors an explicit modulePath, bypassing discovery', async () => {
    const root = makeRoot();
    const marker = `__genreg_explicit_${Date.now()}`;
    const explicit = join(root, 'custom', 'registry.js');
    writeRegistry(explicit, marker);

    const found = await importGeneratedRegistry('models.registry', {
      rootDir: root,
      modulePath: explicit,
    });

    assert.equal(found, true);
    assert.equal((globalThis as Record<string, unknown>)[marker], 1);
  });

  it('returns false for a missing explicit modulePath', async () => {
    const root = makeRoot();
    const found = await importGeneratedRegistry('models.registry', {
      rootDir: root,
      modulePath: join(root, 'nope.js'),
    });
    assert.equal(found, false);
  });
});
