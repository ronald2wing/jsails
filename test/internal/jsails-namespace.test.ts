import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { installJsailsGlobal, jsails } from '../../src/internal/jsails-namespace.js';

type GlobalWithJsails = { jsails?: unknown };

describe('jsails runtime namespace', () => {
  it('is installed on globalThis when the module loads', () => {
    assert.equal((globalThis as GlobalWithJsails).jsails, jsails);
  });

  it('exposes the full decorator surface', () => {
    assert.deepEqual(Object.keys(jsails).sort(), [
      'belongsTo',
      'encrypts',
      'enum',
      'hasMany',
      'hasOne',
      'maxLength',
      'nullable',
      'renamedFrom',
      'unique',
    ]);
  });

  it('every factory returns an applicable, no-op PropertyDecorator', () => {
    for (const key of Object.keys(jsails) as (keyof typeof jsails)[]) {
      const decorator = (jsails[key] as (...args: unknown[]) => PropertyDecorator)();
      assert.equal(typeof decorator, 'function');
      // Applying it must not throw (and must do nothing).
      assert.equal(decorator({}, 'field'), undefined);
    }
  });

  it('installJsailsGlobal is idempotent', () => {
    (globalThis as GlobalWithJsails).jsails = undefined;
    installJsailsGlobal();
    assert.equal((globalThis as GlobalWithJsails).jsails, jsails);
    installJsailsGlobal();
    assert.equal((globalThis as GlobalWithJsails).jsails, jsails);
  });
});
