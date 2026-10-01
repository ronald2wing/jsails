import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { CompilerError } from '../../src/compiler/errors.js';
import { extractRegions } from '../../src/compiler/regions.js';

// Resolve the fixture from the repo root: templates are not copied into dist/.
const packageRoot = fileURLToPath(new URL('../../..', import.meta.url));
const taskListFixture = readFileSync(
  join(packageRoot, 'templates/starter/components/task-list.tsx'),
  'utf-8',
);

function expectCompilerError(fn: () => unknown, code: string, subject?: string): CompilerError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof CompilerError, `expected CompilerError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (subject !== undefined) {
      assert.equal(error.subject, subject);
    }
    return error;
  }
  assert.fail('expected CompilerError to be thrown');
}

describe('extractRegions', () => {
  it('extracts all four regions from the real fixture', () => {
    const regions = extractRegions(taskListFixture, 'task-list.tsx');
    assert.ok(regions.model.includes('stateSchema'));
    assert.ok(regions.style.includes('defineStyle'));
    assert.ok(regions.view.includes('defineComponent'));
    assert.equal(typeof regions.server, 'string');
    // The preamble carries the file doc comment and imports.
    assert.ok(regions.preamble.includes("from 'zod'"));
    assert.ok(regions.preamble.includes('application-component'));
  });

  it('throws missing_region when a required region is absent', () => {
    const code = `// #region server
// #endregion server
// #region style
// #endregion style
// #region view
// #endregion view
`;
    expectCompilerError(() => extractRegions(code, 'x.tsx'), 'missing_region', 'model');
  });

  it('throws invalid_region on a duplicate region', () => {
    const code = `// #region model
// #endregion model
// #region model
// #endregion model
// #region server
// #endregion server
// #region style
// #endregion style
// #region view
// #endregion view
`;
    expectCompilerError(() => extractRegions(code, 'x.tsx'), 'invalid_region', 'model');
  });

  it('throws invalid_region on an unclosed region', () => {
    const code = `// #region model
const stateSchema = 1;
// #region server
// #endregion server
// #region style
// #endregion style
// #region view
// #endregion view
`;
    expectCompilerError(() => extractRegions(code, 'x.tsx'), 'invalid_region', 'model');
  });

  it('throws invalid_region on a stray endregion', () => {
    const code = `const decoy = 1;
// #endregion model
`;
    expectCompilerError(() => extractRegions(code, 'x.tsx'), 'invalid_region', 'model');
  });

  it('keeps the error message free of source text', () => {
    const code = `const SUPER_SECRET_TOKEN = 'do-not-leak';
// #region server
// #endregion server
// #region style
// #endregion style
// #region view
// #endregion view
`;
    const error = expectCompilerError(
      () => extractRegions(code, 'x.tsx'),
      'missing_region',
      'model',
    );
    assert.ok(!error.message.includes('SUPER_SECRET_TOKEN'));
    assert.ok(!error.message.includes('do-not-leak'));
  });

  it('reports the offset of each region body in the original source', () => {
    const code = `// #region model
const a = 1;
// #endregion model
// #region server
// #endregion server
// #region style
// #endregion style
// #region view
<p>hi</p>
// #endregion view
`;
    const regions = extractRegions(code, 'x.tsx');
    // The model offset points at the first kept body line.
    assert.equal(code.slice(regions.offsets.model, regions.offsets.model + 9), 'const a =');
    assert.equal(code.slice(regions.offsets.view, regions.offsets.view + 3), '<p>');
  });

  it('skips leading blank lines when computing a region offset', () => {
    const code = `// #region model
const a = 1;
// #endregion model
// #region server
// #endregion server
// #region style
// #endregion style
// #region view

<p>hi</p>
// #endregion view
`;
    const regions = extractRegions(code, 'x.tsx');
    assert.equal(code.slice(regions.offsets.view, regions.offsets.view + 3), '<p>');
  });
});
