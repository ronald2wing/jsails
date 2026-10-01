import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PluginEnablementError, resolvePluginEnablement } from '../../src/plugins/enablement.js';
import { PLUGIN_STATE_VERSION, type PluginState } from '../../src/plugins/state-store.js';

/** A managed state document with the given per-id entries. */
function state(entries: Record<string, { active: string; enabled: boolean }>): PluginState {
  return { version: PLUGIN_STATE_VERSION, plugins: entries };
}

describe('resolvePluginEnablement', () => {
  it('enables code-only plugins when there is no managed state', () => {
    assert.deepEqual(resolvePluginEnablement({ codeEnabled: ['acme', 'tasks'] }), {
      enabled: ['acme', 'tasks'],
      conflicts: [],
      managedEnabled: [],
      codeEnabled: ['acme', 'tasks'],
      disabledManaged: [],
    });
  });

  it('enables managed-only plugins when there is no code list', () => {
    assert.deepEqual(
      resolvePluginEnablement({
        state: state({
          acme: { active: '1.2.3', enabled: true },
          tasks: { active: '2.0.0', enabled: false },
        }),
      }),
      {
        enabled: ['acme'],
        conflicts: [],
        managedEnabled: ['acme'],
        codeEnabled: [],
        disabledManaged: ['tasks'],
      },
    );
  });

  it('sorts the deduped union of both sources deterministically', () => {
    assert.deepEqual(
      resolvePluginEnablement({
        codeEnabled: ['zebra', 'acme', 'acme'],
        state: state({
          tasks: { active: '2.0.0', enabled: true },
          beta: { active: '1.0.0', enabled: true },
        }),
      }),
      {
        enabled: ['acme', 'beta', 'tasks', 'zebra'],
        conflicts: [],
        managedEnabled: ['beta', 'tasks'],
        codeEnabled: ['acme', 'zebra'],
        disabledManaged: [],
      },
    );
  });

  it('detects a conflict and excludes the id from enabled', () => {
    const result = resolvePluginEnablement({
      codeEnabled: ['acme', 'zebra'],
      state: state({ acme: { active: '1.0.0', enabled: true } }),
    });
    assert.deepEqual(result, {
      enabled: ['zebra'],
      conflicts: ['acme'],
      managedEnabled: [],
      codeEnabled: ['zebra'],
      disabledManaged: [],
    });
  });

  it('treats a code id present in state as a conflict even when disabled', () => {
    const result = resolvePluginEnablement({
      codeEnabled: ['acme'],
      state: state({ acme: { active: '1.0.0', enabled: false } }),
    });
    assert.deepEqual(result.enabled, []);
    assert.deepEqual(result.conflicts, ['acme']);
    assert.deepEqual(result.disabledManaged, []);
  });

  it('excludes a disabled managed plugin from enabled', () => {
    assert.deepEqual(
      resolvePluginEnablement({
        state: state({
          acme: { active: '1.2.3', enabled: true },
          tasks: { active: '2.0.0', enabled: false },
        }),
      }).enabled,
      ['acme'],
    );
  });

  it('rejects an invalid code id value-free', () => {
    assert.throws(
      () => resolvePluginEnablement({ codeEnabled: ['Bad!'] }),
      (error: unknown) => error instanceof PluginEnablementError && !error.message.includes('Bad!'),
    );
  });

  it('handles empty and absent inputs', () => {
    assert.deepEqual(resolvePluginEnablement({}), {
      enabled: [],
      conflicts: [],
      managedEnabled: [],
      codeEnabled: [],
      disabledManaged: [],
    });
    assert.deepEqual(resolvePluginEnablement({ codeEnabled: undefined, state: undefined }), {
      enabled: [],
      conflicts: [],
      managedEnabled: [],
      codeEnabled: [],
      disabledManaged: [],
    });
    assert.deepEqual(resolvePluginEnablement({ codeEnabled: [] }), {
      enabled: [],
      conflicts: [],
      managedEnabled: [],
      codeEnabled: [],
      disabledManaged: [],
    });
  });

  it('is deterministic and frozen', () => {
    const input = {
      codeEnabled: ['acme', 'zebra'],
      state: state({ beta: { active: '1.0.0', enabled: true } }),
    };
    const first = resolvePluginEnablement(input);
    const second = resolvePluginEnablement(input);

    assert.deepEqual(second, first);
    assert.equal(Object.isFrozen(first), true);
    for (const list of [
      first.enabled,
      first.conflicts,
      first.managedEnabled,
      first.codeEnabled,
      first.disabledManaged,
    ]) {
      assert.equal(Object.isFrozen(list), true);
    }
  });
});
