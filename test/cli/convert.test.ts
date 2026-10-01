import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { runConvertCommand } from '../../src/cli/convert-commands.js';

/**
 * End-to-end `convert:component` over a temp tree. The command resolves
 * `<dir>/components/<name>`, so every case writes into its own fixture
 * directory and the repo tree is never touched.
 *
 * Contract under test: a refusal is uniform — the command prints a value-free
 * message, sets `process.exitCode = 1`, and RETURNS 1. It never throws for a
 * refusal (a thrown error would crash the CLI with a stack trace).
 */

const tmpRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'convert-fixture-'),
);

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

let dirSeq = 0;

function freshDir(): string {
  const dir = join(tmpRoot, `convert-${dirSeq++}`);
  mkdirSync(join(dir, 'components'), { recursive: true });
  return dir;
}

const cleanSfc = `import { z } from 'zod';
import { defineComponent, defineStyle } from '../app/application-component.js';

const stateSchema = z.object({ title: z.string() }).strict();
type WidgetState = z.infer<typeof stateSchema>;
const style = defineStyle({ card: 'card' });

export const widget = defineComponent<WidgetState>({
  name: 'widget',
  stateSchema,
  style,
  initialState() {
    return { title: '' };
  },
  render(state) {
    return null;
  },
});
`;

function writeSfc(dir: string, name: string, code: string): string {
  const filePath = join(dir, 'components', `${name}.tsx`);
  writeFileSync(filePath, code, 'utf-8');
  return filePath;
}

/** Runs the command and asserts it did not throw, returning the exit code. */
async function run(args: readonly string[]): Promise<number> {
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    return await runConvertCommand(args);
  } finally {
    process.exitCode = previous;
  }
}

describe('runConvertCommand: SFC -> MFC', () => {
  it('splits a clean SFC into a directory and removes the SFC', async () => {
    const dir = freshDir();
    const sfcPath = writeSfc(dir, 'widget', cleanSfc);

    const code = await run(['widget', '--dir', dir]);
    assert.equal(code, 0);

    const mfcDir = join(dir, 'components', 'widget');
    assert.ok(existsSync(join(mfcDir, 'index.tsx')), 'index.tsx expected');
    assert.ok(existsSync(join(mfcDir, 'widget.model.ts')), 'model part expected');
    assert.ok(existsSync(join(mfcDir, 'widget.style.ts')), 'style part expected');
    assert.ok(!existsSync(sfcPath), 'the SFC must be removed');

    // The model part is self-contained: it carries its own `z` import.
    const model = readFileSync(join(mfcDir, 'widget.model.ts'), 'utf-8');
    assert.match(model, /import \{ z \} from 'zod'/);
  });

  it('round-trips MFC -> SFC and restores a single file', async () => {
    const dir = freshDir();
    writeSfc(dir, 'widget', cleanSfc);

    assert.equal(await run(['widget', '--dir', dir]), 0);
    assert.equal(await run(['widget', '--dir', dir]), 0);

    const sfcPath = join(dir, 'components', 'widget.tsx');
    assert.ok(existsSync(sfcPath), 'the SFC must be restored');
    assert.ok(!existsSync(join(dir, 'components', 'widget')), 'the directory must be removed');

    const restored = readFileSync(sfcPath, 'utf-8');
    assert.match(restored, /const stateSchema = z\.object/);
    assert.match(restored, /const style = defineStyle/);
    assert.match(restored, /export const widget = defineComponent/);
    // Imports are merged, not duplicated.
    assert.equal((restored.match(/from 'zod'/g) ?? []).length, 1);
  });
});

describe('runConvertCommand: refusals are uniform and value-free', () => {
  it('refuses not_found without throwing', async () => {
    const dir = freshDir();
    assert.equal(await run(['missing', '--dir', dir]), 1);
  });

  it('refuses already_sfc when --sfc names the current shape', async () => {
    const dir = freshDir();
    writeSfc(dir, 'widget', cleanSfc);
    assert.equal(await run(['widget', '--sfc', '--dir', dir]), 1);
  });

  it('refuses already_mfc when --mfc names the current shape', async () => {
    const dir = freshDir();
    writeSfc(dir, 'widget', cleanSfc);
    assert.equal(await run(['widget', '--dir', dir]), 0);
    assert.equal(await run(['widget', '--mfc', '--dir', dir]), 1);
  });

  it('refuses ambiguous_shape when both shapes are present', async () => {
    const dir = freshDir();
    writeSfc(dir, 'widget', cleanSfc);
    mkdirSync(join(dir, 'components', 'widget'), { recursive: true });
    writeFileSync(join(dir, 'components', 'widget', 'index.tsx'), cleanSfc, 'utf-8');
    assert.equal(await run(['widget', '--dir', dir]), 1);
  });

  it('refuses unmigratable_reference without throwing', async () => {
    const dir = freshDir();
    const withLocal = `import { z } from 'zod';
import { defineComponent } from '../app/application-component.js';

const MAX = 10;
const stateSchema = z.object({ title: z.string().max(MAX) }).strict();
type S = z.infer<typeof stateSchema>;

export const widget = defineComponent<S>({ name: 'widget', stateSchema });
`;
    writeSfc(dir, 'widget', withLocal);
    assert.equal(await run(['widget', '--dir', dir]), 1);
    // The refusal must not have created the directory.
    assert.ok(!existsSync(join(dir, 'components', 'widget')));
  });
});
