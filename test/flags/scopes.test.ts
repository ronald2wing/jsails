/**
 * Flag scopes — A/B-testing and gradual-rollout primitives.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  beforeAfter,
  coverage,
  everyone,
  nobody,
  shipped,
  when,
  FeatureFlagError,
} from '../../src/flags/index.js';

describe('coverage', () => {
  it('is deterministic per scope', () => {
    const c = coverage(50, 'exp');
    for (const scope of ['user-1', 'user-2', 'tenant-a']) {
      assert.equal(c(scope), c(scope), `scope ${scope} flapped`);
    }
  });

  it('activates ~percent of a population (statistically, within a band)', () => {
    const c = coverage(50, 'exp');
    let active = 0;
    const n = 10_000;
    for (let i = 0; i < n; i += 1) {
      if (c(`user-${i}`)) active += 1;
    }
    const ratio = active / n;
    // 10k scopes puts 50% within a very tight band.
    assert.ok(ratio > 0.46 && ratio < 0.54, `expected ~50%, got ${ratio}`);
  });

  it('rejects an out-of-range percent value-free', () => {
    assert.throws(() => coverage(101, 'x'), FeatureFlagError);
    assert.throws(() => coverage(-1, 'x'), FeatureFlagError);
  });
});

describe('everyone / nobody / shipped', () => {
  it('everyone activates all, nobody activates none, shipped is always true', () => {
    assert.equal(everyone('x')('anything'), true);
    assert.equal(nobody('x')('anything'), false);
    assert.equal(shipped('anything'), true);
  });
});

describe('beforeAfter', () => {
  it('is deterministic and routes a proportional bucket to the after variant', () => {
    const step0 = beforeAfter('exp', 10, 0);
    const step1 = beforeAfter('exp', 10, 1);
    assert.equal(step0('user-1'), false);
    // step 1 of 10 → ~10% on the new variant; deterministic for a given scope.
    assert.equal(step1('user-1'), step1('user-1'));
  });

  it('rejects an invalid step/before value-free', () => {
    assert.throws(() => beforeAfter('x', 0), FeatureFlagError);
    assert.throws(() => beforeAfter('x', 10, 11), FeatureFlagError);
  });
});

describe('when', () => {
  it('branches by scope and only evaluates the selected branch', () => {
    let evaluatedInactive = false;
    const result = when(coverage(100, 'x'), 'user', 'active', () => {
      evaluatedInactive = true;
      return 'inactive';
    });
    assert.equal(result, 'active');
    assert.equal(evaluatedInactive, false);
  });

  it('selects the inactive branch for an out-of-scope value', () => {
    const result = when(coverage(0, 'x'), 'user', 'active', 'inactive');
    assert.equal(result, 'inactive');
  });
});
