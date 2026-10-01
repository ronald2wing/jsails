/**
 * Tests for `createComponentTestHarness` (`jsails/testing`).
 *
 * Every test exercises the real server-component runtime through the harness —
 * no HTTP server, Hono app, or browser is needed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

import { defineAction, defineServerComponent } from '../../src/server-components/component.js';
import { createComponentTestHarness } from '../../src/testing/index.js';

import type { ServerComponentDefinition } from '../../src/server-components/component.js';

// ---------------------------------------------------------------------------
// Fixture component
// ---------------------------------------------------------------------------

type CounterState = { count: number; title: string };

const counter: ServerComponentDefinition<CounterState> = defineServerComponent<CounterState>({
  name: 'Counter',
  stateSchema: z.object({ count: z.number(), title: z.string() }).strict(),
  writableKeys: ['title'],
  initialState() {
    return { count: 0, title: 'hello' };
  },
  authorize() {
    return true;
  },
  actions: {
    increment: defineAction({
      input: z.object({ by: z.number() }).strict(),
      run(state, input) {
        state.count += input.by;
      },
    }),
  },
  render(state, { bind, call, values }) {
    return (
      <div>
        <input {...bind('title')} value={values.title ?? state.title} />
        <button {...call('increment', { by: 1 })}>+</button>
        <span id="count">{state.count}</span>
        <span id="title">{state.title}</span>
      </div>
    );
  },
});

const COMPONENTS = { Counter: counter };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createComponentTestHarness', () => {
  it('render returns HTML with component root and non-empty snapshot + csrf', async () => {
    const harness = createComponentTestHarness({ components: COMPONENTS });
    try {
      const { html, snapshot, csrf } = await harness.render('Counter');

      assert.match(html, /data-jsails-component="Counter"/);
      assert.match(html, /data-jsails-component-name="Counter"/);
      assert.ok(snapshot.length > 0, 'snapshot should not be empty');
      assert.ok(csrf.length > 0, 'csrf should not be empty');
      assert.match(html, /value="hello"/);
      assert.match(html, />0<\/span>/);
    } finally {
      await harness.close();
    }
  });

  it('update with a writable edit re-signs and returns new snapshot + synchronized html', async () => {
    const harness = createComponentTestHarness({ components: COMPONENTS });
    try {
      const { snapshot, csrf } = await harness.render('Counter');

      const result = await harness.update(snapshot, { title: 'changed' }, { csrf });
      assert.equal(result.status, 200);
      assert.ok(result.snapshot, 'should return a re-signed snapshot');
      assert.ok(result.html, 'should return re-rendered html');
      const html = result.html;
      assert.match(html, /value="changed"/);
      assert.ok(html.indexOf('error') === -1, 'html should not contain error');
    } finally {
      await harness.close();
    }
  });

  it('update runs an action and reflects the mutated state', async () => {
    const harness = createComponentTestHarness({ components: COMPONENTS });
    try {
      const { snapshot, csrf } = await harness.render('Counter');

      const result = await harness.update(
        snapshot,
        {},
        { csrf, action: { name: 'increment', args: { by: 5 } } },
      );
      assert.equal(result.status, 200);
      const actionHtml = result.html as string;
      assert.match(actionHtml, />5<\/span>/);
    } finally {
      await harness.close();
    }
  });

  it('update rejects a missing CSRF token', async () => {
    const harness = createComponentTestHarness({ components: COMPONENTS });
    try {
      const { snapshot } = await harness.render('Counter');

      // No CSRF token supplied — the anonymous CSRF is the snapshot id,
      // but without the header the runtime should reject.
      const result = await harness.update(snapshot, {});
      assert.ok(result.status !== 200, 'should not succeed');
      const body = result.body as Record<string, unknown>;
      const error = body.error as { code: string } | undefined;
      assert.ok(error !== undefined, 'body should carry an error');
      const csrfError = error;
      assert.equal(csrfError.code, 'csrf_mismatch');
    } finally {
      await harness.close();
    }
  });

  it('update rejects a tampered snapshot', async () => {
    const harness = createComponentTestHarness({ components: COMPONENTS });
    try {
      const { csrf } = await harness.render('Counter');

      const result = await harness.update('tampered-snapshot-token', {}, { csrf });
      assert.ok(result.status !== 200, 'should not succeed');
      const body = result.body as Record<string, unknown>;
      const error = body.error as { code: string } | undefined;
      assert.ok(error !== undefined, 'body should carry an error');
      const tamperError = error;
      assert.equal(tamperError.code, 'invalid_snapshot');
    } finally {
      await harness.close();
    }
  });

  it('update rejects a client edit to a locked (non-writable) key', async () => {
    const harness = createComponentTestHarness({ components: COMPONENTS });
    try {
      const { snapshot, csrf } = await harness.render('Counter');

      // `count` is not in `writableKeys` — the runtime should reject the edit
      // with a validation error rather than silently applying it.
      const result = await harness.update(snapshot, { count: 99 }, { csrf });
      assert.ok(result.status !== 200, 'should not succeed');
      const body = result.body as Record<string, unknown>;
      const errors = body.errors as Record<string, string> | undefined;
      assert.ok(errors !== undefined, 'body should carry field errors');
      const fieldErrors = errors;
      assert.ok(Object.keys(fieldErrors).length > 0, 'should have at least one field error');
    } finally {
      await harness.close();
    }
  });

  it('close is idempotent', async () => {
    const harness = createComponentTestHarness({ components: COMPONENTS });

    await harness.close();
    // Second close must not throw.
    await harness.close();
  });

  it('lifecycle auto-closes the harness', async () => {
    const afterCalls: (() => void | Promise<void>)[] = [];

    const lifecycle = {
      after(callback: () => void | Promise<void>) {
        afterCalls.push(callback);
      },
    };

    const harness = createComponentTestHarness({ components: COMPONENTS, lifecycle });
    assert.equal(afterCalls.length, 1, 'lifecycle should register one after callback');

    // The harness should still be usable before lifecycle fires.
    const { html } = await harness.render('Counter');
    assert.match(html, /data-jsails-component="Counter"/);

    // Fire the lifecycle — this is what `node:test` does after the test.
    await afterCalls[0]!();

    // After close, render should throw.
    await assert.rejects(
      () => harness.render('Counter'),
      /closed/,
      'should reject after lifecycle close',
    );
  });
});
