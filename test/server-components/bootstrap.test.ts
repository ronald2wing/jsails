import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, describe, it } from 'node:test';

import { bootstrapComponents } from '../../src/server-components/bootstrap.js';

const createdDirs: string[] = [];

after(() => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-bootstrap-components-'));
  createdDirs.push(dir);
  return dir;
}

describe('bootstrapComponents', () => {
  it('imports the compiled component registry when present', async () => {
    const root = makeRoot();
    const marker = `__bootstrap_components_${Date.now()}`;
    const registry = join(root, 'dist', '.jsails', 'components.registry.js');
    mkdirSync(join(registry, '..'), { recursive: true });
    writeFileSync(registry, `globalThis.${marker} = true;\n`);

    const found = await bootstrapComponents({ rootDir: root });

    assert.equal(found, true);
    assert.equal((globalThis as Record<string, unknown>)[marker], true);
  });

  it('is a silent no-op when the project has no registry', async () => {
    const root = makeRoot();
    const found = await bootstrapComponents({ rootDir: root });
    assert.equal(found, false);
  });
});
