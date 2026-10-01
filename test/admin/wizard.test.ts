/**
 * Admin wizard tests: descriptor validation, field collection, per-step value
 * extraction, and rendering.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { h, type VNode } from 'preact';

import {
  WizardError,
  collectWizardFields,
  defineWizard,
  renderWizard,
  wizardStepValues,
  type WizardDefinition,
  type RenderWizardOptions,
  type WizardStep,
} from '../../src/admin/wizard.js';
import type { ResourceField } from '../../src/admin/resource.js';
import type { TabRenderState } from '../../src/admin/tabs.js';
import { renderToString } from '../../src/jsx/render-to-string.js';

const FIELDS: readonly ResourceField[] = [
  { name: 'title', label: 'Title', type: 'text' },
  {
    name: 'status',
    label: 'Status',
    type: 'select',
    options: [{ value: 'active', label: 'Active' }],
  },
  { name: 'body', label: 'Body', type: 'textarea' },
  { name: 'publish', label: 'Publish', type: 'toggle' },
];

function makeState(overrides: Partial<TabRenderState> = {}): TabRenderState {
  return {
    values: { title: 'Hello', status: 'active', body: 'content' },
    errors: {},
    csrf: 'test-csrf',
    action: '/admin/items',
    back: '',
    ...overrides,
  };
}

function defaultRenderField(field: ResourceField, _state: TabRenderState, id: string): VNode<any> {
  return h('input', { type: 'text', name: field.name, id });
}

function renderOpts(
  currentStep: number,
  extra: Partial<RenderWizardOptions> = {},
): RenderWizardOptions {
  return {
    currentStep,
    totalSteps: 3,
    renderField: defaultRenderField,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Descriptor validation
// ---------------------------------------------------------------------------

describe('defineWizard validation', () => {
  it('accepts a valid wizard spec', () => {
    const spec: WizardDefinition = {
      steps: [
        { name: 'basic', label: 'Basic', fields: ['title', 'status'] },
        { name: 'content', label: 'Content', fields: ['body'] },
        { name: 'review', label: 'Review', fields: ['publish'] },
      ],
    };
    const wizard = defineWizard(spec);
    assert.equal(wizard.steps.length, 3);
    assert.equal(wizard.steps[0]!.name, 'basic');
    assert.equal(wizard.steps[0]!.label, 'Basic');
    assert.deepEqual([...wizard.steps[0]!.fields], ['title', 'status']);
    assert.ok(Object.isFrozen(wizard));
    assert.ok(Object.isFrozen(wizard.steps));
    assert.ok(Object.isFrozen(wizard.steps[0]!));
  });

  it('rejects a non-object spec', () => {
    assert.throws(() => defineWizard(null as never), WizardError);
    assert.throws(() => defineWizard([] as never), WizardError);
  });

  it('rejects empty steps array', () => {
    assert.throws(() => defineWizard({ steps: [] }), WizardError);
  });

  it('rejects steps with non-object entries', () => {
    assert.throws(() => defineWizard({ steps: [null as never] }), WizardError);
  });

  it('rejects empty step name', () => {
    assert.throws(
      () => defineWizard({ steps: [{ name: '', label: 'A', fields: ['x'] }] }),
      WizardError,
    );
  });

  it('rejects empty step label', () => {
    assert.throws(
      () => defineWizard({ steps: [{ name: 'a', label: '  ', fields: ['x'] }] }),
      WizardError,
    );
  });

  it('rejects empty fields array', () => {
    assert.throws(
      () => defineWizard({ steps: [{ name: 'a', label: 'A', fields: [] }] }),
      WizardError,
    );
  });

  it('rejects non-string field names', () => {
    assert.throws(
      () => defineWizard({ steps: [{ name: 'a', label: 'A', fields: [1 as never] }] }),
      WizardError,
    );
  });

  it('rejects duplicate step names', () => {
    assert.throws(
      () =>
        defineWizard({
          steps: [
            { name: 'a', label: 'A', fields: ['x'] },
            { name: 'a', label: 'B', fields: ['y'] },
          ],
        }),
      WizardError,
    );
  });
});

// ---------------------------------------------------------------------------
// Field collection
// ---------------------------------------------------------------------------

describe('collectWizardFields', () => {
  it('collects all field names across steps and reports missing', () => {
    const wizard = defineWizard({
      steps: [
        { name: 's1', label: 'Step 1', fields: ['title', 'status'] },
        { name: 's2', label: 'Step 2', fields: ['body', 'unknown'] },
      ],
    });
    const { wizardFields, missing } = collectWizardFields(wizard, FIELDS);
    assert.equal(wizardFields.size, 4);
    assert.ok(wizardFields.has('title'));
    assert.ok(wizardFields.has('status'));
    assert.ok(wizardFields.has('body'));
    assert.ok(wizardFields.has('unknown'));
    assert.deepEqual(missing, ['unknown']);
  });

  it('returns no missing when all fields match', () => {
    const wizard = defineWizard({
      steps: [{ name: 's1', label: 'Step 1', fields: ['title', 'body'] }],
    });
    const { wizardFields, missing } = collectWizardFields(wizard, FIELDS);
    assert.equal(wizardFields.size, 2);
    assert.equal(missing.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Per-step value extraction
// ---------------------------------------------------------------------------

describe('wizardStepValues', () => {
  it('extracts only the fields belonging to a step', () => {
    const step: WizardStep = { name: 's1', label: 'S1', fields: ['title'] };
    const values = { title: 'Hello', body: 'World', csrf: 'x' };
    const subset = wizardStepValues(step, values);
    assert.deepEqual(subset, { title: 'Hello' });
  });

  it('returns an empty object for a step with no matching values', () => {
    const step: WizardStep = { name: 's2', label: 'S2', fields: ['missing'] };
    const values = { title: 'Hello' };
    assert.deepEqual(wizardStepValues(step, values), {});
  });

  it('preserves values matching the step fields only', () => {
    const step: WizardStep = { name: 's1', label: 'S1', fields: ['title', 'status'] };
    const values = { title: 'T', status: 'active', body: 'B', extra: 'X' };
    assert.deepEqual(wizardStepValues(step, values), { title: 'T', status: 'active' });
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('renderWizard', () => {
  const wizard = defineWizard({
    steps: [
      { name: 'basic', label: 'Basic Info', fields: ['title', 'status'] },
      { name: 'content', label: 'Content', fields: ['body'] },
      { name: 'review', label: 'Review & Publish', fields: ['publish'] },
    ],
  });

  it('renders the step indicator and active step fields', () => {
    const html = renderToString(renderWizard(wizard, FIELDS, makeState(), renderOpts(0)));
    assert.match(html, /admin-wizard/);
    assert.match(html, /admin-wizard-steps/);
    assert.match(html, /Basic Info/);
    assert.match(html, /Content/);
    assert.match(html, /Review &amp; Publish/);
    // Step 0 fields.
    assert.match(html, /name="title"/);
    assert.match(html, /name="status"/);
    // Step 1+ fields absent.
    assert.doesNotMatch(html, /name="body"/);
    assert.doesNotMatch(html, /name="publish"/);
  });

  it('renders step 1 fields when currentStep is 1', () => {
    const html = renderToString(renderWizard(wizard, FIELDS, makeState(), renderOpts(1)));
    assert.match(html, /name="body"/);
    assert.doesNotMatch(html, /name="title"/);
    assert.doesNotMatch(html, /name="publish"/);
  });

  it('renders Previous and Next buttons on intermediate steps', () => {
    const html = renderToString(renderWizard(wizard, FIELDS, makeState(), renderOpts(1)));
    assert.match(html, /_wizard_prev/);
    assert.match(html, /_wizard_next/);
    assert.match(html, /Previous/);
    assert.match(html, /Next/);
  });

  it('renders only Next button on the first step', () => {
    const html = renderToString(renderWizard(wizard, FIELDS, makeState(), renderOpts(0)));
    assert.doesNotMatch(html, /_wizard_prev/);
    assert.match(html, /_wizard_next/);
  });

  it('renders only Previous and Submit on the last step', () => {
    const html = renderToString(renderWizard(wizard, FIELDS, makeState(), renderOpts(2)));
    assert.match(html, /_wizard_prev/);
    assert.doesNotMatch(html, /_wizard_next/);
    assert.match(html, /admin-wizard-submit/);
    assert.match(html, />Save</);
  });

  it('clamps out-of-bounds currentStep', () => {
    // Negative -> 0 (first step, no previous, has next).
    let html = renderToString(renderWizard(wizard, FIELDS, makeState(), renderOpts(-1)));
    assert.doesNotMatch(html, /_wizard_prev/);
    assert.match(html, /_wizard_next/);
    assert.match(html, /name="title"/);

    // Too high -> last step (Previous + Submit).
    html = renderToString(renderWizard(wizard, FIELDS, makeState(), renderOpts(99)));
    assert.match(html, /_wizard_prev/);
    assert.doesNotMatch(html, /_wizard_next/);
    assert.match(html, /admin-wizard-submit/);
  });

  it('renders the csrf hidden input', () => {
    const html = renderToString(
      renderWizard(wizard, FIELDS, makeState({ csrf: 'csrf-wiz' }), renderOpts(0)),
    );
    assert.match(html, /value="csrf-wiz"/);
  });

  it('renders the _wizard_step hidden marker', () => {
    const html = renderToString(renderWizard(wizard, FIELDS, makeState(), renderOpts(1)));
    assert.match(html, /name="_wizard_step" value="1"/);
  });

  it('skips fields with no matching resource field', () => {
    const customWizard = defineWizard({
      steps: [{ name: 'a', label: 'A', fields: ['nonexistent'] }],
    });
    const html = renderToString(renderWizard(customWizard, FIELDS, makeState(), renderOpts(0)));
    assert.doesNotMatch(html, /name="nonexistent"/);
  });

  it('renders the back hidden input when present', () => {
    const html = renderToString(
      renderWizard(wizard, FIELDS, makeState({ back: 'page=2' }), renderOpts(0)),
    );
    assert.match(html, /name="_back" value="page=2"/);
  });

  it('does not render back hidden when back is empty', () => {
    const html = renderToString(
      renderWizard(wizard, FIELDS, makeState({ back: '' }), renderOpts(0)),
    );
    assert.doesNotMatch(html, /name="_back"/);
  });
});
