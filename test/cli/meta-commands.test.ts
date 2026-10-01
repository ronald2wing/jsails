import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, describe, it } from 'node:test';

import { runMetaCommand } from '../../src/cli/meta-commands.js';

const createdDirs: string[] = [];

after(() => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-meta-cmd-'));
  createdDirs.push(dir);
  return dir;
}

/** Capture `console.log`/`console.error` so tests can assert on output. */
function captureConsole(): { logs: string[]; errors: string[]; restore: () => void } {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

describe('runMetaCommand', () => {
  it('writes the .jsails artifacts and reports counts', async () => {
    const root = makeProject();
    mkdirSync(join(root, 'models'), { recursive: true });
    writeFileSync(
      join(root, 'models', 'post.ts'),
      "import { ApplicationRecord } from 'jsails';\nexport class Post extends ApplicationRecord {\n  declare id: number;\n  declare title: string;\n}\n",
    );

    const cap = captureConsole();
    let code: number;
    try {
      code = await runMetaCommand({ dir: root });
    } finally {
      cap.restore();
    }

    assert.equal(code, 0);
    assert.ok(existsSync(join(root, '.jsails', 'models.registry.ts')));
    assert.ok(existsSync(join(root, '.jsails', 'components.registry.ts')));
    assert.ok(existsSync(join(root, '.jsails', 'autoload.json')));
    assert.ok(cap.logs.some((line) => line.includes('1 model(s)')));
  });

  it('writes an empty model registry for a project with no models', async () => {
    const root = makeProject();

    const cap = captureConsole();
    let code: number;
    try {
      code = await runMetaCommand({ dir: root });
    } finally {
      cap.restore();
    }

    assert.equal(code, 0);
    const registry = readFileSync(join(root, '.jsails', 'models.registry.ts'), 'utf8');
    assert.match(registry, /export \{\};/);
  });

  it('defaults the project root to the current working directory', async () => {
    const root = makeProject();
    const originalCwd = process.cwd();
    const cap = captureConsole();
    let code: number;
    try {
      process.chdir(root);
      code = await runMetaCommand();
    } finally {
      process.chdir(originalCwd);
      cap.restore();
    }

    assert.equal(code, 0);
    assert.ok(existsSync(join(root, '.jsails', 'models.registry.ts')));
  });
});
