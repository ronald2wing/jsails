import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  ConvertComponentError,
  detectComponentShape,
  planCombine,
  planSplit,
} from '../../src/compiler/component-shape.js';

// Resolve the fixture from the repo root: templates are not copied into dist/.
const packageRoot = fileURLToPath(new URL('../../..', import.meta.url));
const taskListFixture = readFileSync(
  join(packageRoot, 'templates/starter/components/task-list.tsx'),
  'utf-8',
);

/**
 * A clean SFC: every migrated binding references only imports or other
 * migrated bindings, so the §12 closure rule admits it.
 */
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

function expectConvertError(
  fn: () => unknown,
  code: string,
  subject?: string,
): ConvertComponentError {
  try {
    fn();
  } catch (error) {
    assert.ok(
      error instanceof ConvertComponentError,
      `expected ConvertComponentError, got ${String(error)}`,
    );
    assert.equal(error.code, code);
    if (subject !== undefined) {
      assert.equal(error.subject, subject);
    }
    return error;
  }
  throw new assert.AssertionError({ message: `expected a ${code} refusal` });
}

describe('detectComponentShape', () => {
  it('reports sfc when only an entry file is present', () => {
    assert.equal(detectComponentShape({ entryFile: 'widget.tsx' }), 'sfc');
  });

  it('reports mfc when only a directory is present', () => {
    assert.equal(detectComponentShape({ directory: { entry: 'widget/index.tsx' } }), 'mfc');
  });

  it('reports ambiguous when both are present', () => {
    assert.equal(
      detectComponentShape({
        entryFile: 'widget.tsx',
        directory: { entry: 'widget/index.tsx' },
      }),
      'ambiguous',
    );
  });

  it('reports none when neither is present', () => {
    assert.equal(detectComponentShape({}), 'none');
  });
});

describe('planSplit', () => {
  it('refuses the real task-list fixture on an entry-local reference', () => {
    const error = expectConvertError(
      () => planSplit(taskListFixture, 'task-list.tsx'),
      'unmigratable_reference',
      'MAX_TITLE_LENGTH',
    );
    // The message names the referencing binding and the offending reference,
    // and never echoes source text.
    assert.match(error.message, /stateSchema/);
    assert.match(error.message, /MAX_TITLE_LENGTH/);
  });

  it('splits a clean SFC into entry + model + style parts', () => {
    const plan = planSplit(cleanSfc, 'widget.tsx');

    assert.ok(plan.model !== undefined, 'model part expected');
    assert.ok(plan.style !== undefined, 'style part expected');
    assert.equal(plan.server, undefined, 'no server part expected');

    // The model part carries the stateSchema binding and its z.infer alias.
    assert.match(plan.model, /const stateSchema = z\.object/);
    assert.match(plan.model, /type WidgetState = z\.infer<typeof stateSchema>/);

    // The style part carries the defineStyle binding.
    assert.match(plan.style, /const style = defineStyle/);

    // The entry keeps the component definition and drops the migrated bindings.
    assert.match(plan.entry, /export const widget = defineComponent/);
    assert.doesNotMatch(plan.entry, /const stateSchema = z\.object/);
    assert.doesNotMatch(plan.entry, /const style = defineStyle/);
  });

  it('carries the imports each part needs into that part', () => {
    const plan = planSplit(cleanSfc, 'widget.tsx');

    // The model part references `z`, so it must import it.
    assert.match(plan.model ?? '', /import \{ z \} from 'zod'/);
    // The style part references `defineStyle`, so it must import it.
    assert.match(plan.style ?? '', /defineStyle/);
    assert.match(
      plan.style ?? '',
      /import \{ defineStyle \} from '\.\.\/app\/application-component\.js'/,
    );
  });

  it('drops entry imports the entry no longer references after split', () => {
    const plan = planSplit(cleanSfc, 'widget.tsx');

    // The entry still uses `defineComponent`, so that import survives.
    assert.match(plan.entry, /defineComponent/);
    // The entry no longer references `z` or `defineStyle` (both migrated), so
    // those specifiers must be pruned from the entry's imports.
    assert.doesNotMatch(plan.entry, /import \{ z \} from 'zod'/);
    assert.doesNotMatch(plan.entry, /defineStyle/);
  });

  it('refuses a component with no splittable parts', () => {
    const bare = `export const widget = { name: 'widget' };\n`;
    expectConvertError(() => planSplit(bare, 'widget.tsx'), 'not_found');
  });

  it('refuses unparseable source value-free', () => {
    const error = expectConvertError(() => planSplit('const = ;\n', 'widget.tsx'), 'unparseable');
    // The parser's codeframe must never surface.
    assert.doesNotMatch(error.message, /const = ;/);
  });
});

describe('planCombine', () => {
  it('round-trips a clean SFC through split then combine', () => {
    const plan = planSplit(cleanSfc, 'widget.tsx');
    const combined = planCombine(
      { entry: plan.entry, model: plan.model, style: plan.style, server: plan.server },
      'widget.tsx',
    );

    // The combined source must re-import z and defineStyle exactly once each.
    assert.equal((combined.match(/from 'zod'/g) ?? []).length, 1);
    assert.equal((combined.match(/from '\.\.\/app\/application-component\.js'/g) ?? []).length, 1);

    // Every original binding survives.
    assert.match(combined, /const stateSchema = z\.object/);
    assert.match(combined, /type WidgetState = z\.infer<typeof stateSchema>/);
    assert.match(combined, /const style = defineStyle/);
    assert.match(combined, /export const widget = defineComponent/);

    // The combined source parses cleanly (no dangling references).
    const reparsed = planSplit(combined, 'widget.tsx');
    assert.ok(reparsed.model !== undefined);
  });

  it('refuses a colliding binding between a part and the entry', () => {
    const entry = `import { z } from 'zod';\nconst stateSchema = z.object({});\nexport const widget = { name: 'widget' };\n`;
    const model = `import { z } from 'zod';\nconst stateSchema = z.object({ title: z.string() });\n`;
    expectConvertError(
      () => planCombine({ entry, model }, 'widget.tsx'),
      'colliding_binding',
      'stateSchema',
    );
  });

  it('refuses an unparseable part value-free', () => {
    const entry = `export const widget = { name: 'widget' };\n`;
    const error = expectConvertError(
      () => planCombine({ entry, model: 'const = ;\n' }, 'widget.tsx'),
      'unparseable',
    );
    assert.doesNotMatch(error.message, /const = ;/);
  });
});
