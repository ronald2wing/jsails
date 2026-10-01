import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSync } from 'rolldown/utils';

import { collectUnmatchedIdentifiers } from '../../src/compiler/scope-walker.js';

/** Parse a module and return the set of free (unmatched) identifier names. */
function free(code: string): ReadonlySet<string> {
  const { program } = parseSync('probe.tsx', code, { sourceType: 'module' });
  return collectUnmatchedIdentifiers(program);
}

function sorted(code: string): string[] {
  return [...free(code)].sort();
}

describe('collectUnmatchedIdentifiers', () => {
  it('returns an empty set for a self-contained module', () => {
    assert.deepEqual(sorted('const x = 1; void x;'), []);
  });

  it('reports a bare free identifier', () => {
    assert.deepEqual(sorted('void useCounter();'), ['useCounter']);
  });

  it('does not report a locally declared const', () => {
    assert.deepEqual(sorted('const useCounter = () => 1; void useCounter();'), []);
  });

  it('does not report an imported binding', () => {
    assert.deepEqual(sorted("import { useCounter } from './x.js'; void useCounter();"), []);
  });

  it('resolves a forward reference to a hoisted function declaration', () => {
    // `b` is declared after `a` but hoists — must not be reported free.
    assert.deepEqual(sorted('function a() { return b(); } function b() {}'), []);
  });

  it('resolves a forward reference to a hoisted class declaration', () => {
    assert.deepEqual(sorted('function a() { return new B(); } class B {}'), []);
  });

  it('resolves a var declared in a nested block (function-scoped hoisting)', () => {
    assert.deepEqual(sorted('if (true) { var y = 1; } void y;'), []);
  });

  it('does not leak a let declared in a nested block', () => {
    // `y` is block-scoped to the `if` body, so the outer reference is free.
    assert.deepEqual(sorted('if (true) { let y = 1; } void y;'), ['y']);
  });

  it('reports a free identifier used inside a function body', () => {
    assert.deepEqual(sorted('function f() { return external; }'), ['external']);
  });

  it('resolves a reference to a sibling function', () => {
    assert.deepEqual(sorted('function a() { return b(); } function b() {} void a();'), []);
  });

  it('does not report an object literal key', () => {
    assert.deepEqual(sorted('const o = { useCounter: 1 }; void o;'), []);
  });

  it('reports a computed object key reference', () => {
    assert.deepEqual(sorted('const o = { [useCounter]: 1 }; void o;'), ['useCounter']);
  });

  it('reports a superclass reference', () => {
    assert.deepEqual(sorted('class A extends Base {} void A;'), ['Base']);
  });

  it('reports a JSX element component reference', () => {
    assert.deepEqual(sorted('const el = <Counter />; void el;'), ['Counter']);
  });

  it('reports a JSX member expression root', () => {
    assert.deepEqual(sorted('const el = <Foo.Bar />; void el;'), ['Foo']);
  });

  it('does not report a lowercase intrinsic JSX element', () => {
    assert.deepEqual(sorted('const el = <div />; void el;'), []);
  });

  it('reports a JSX spread attribute reference', () => {
    assert.deepEqual(sorted('const el = <div {...props} />; void el;'), ['props']);
  });

  it('reports a JSX expression container reference', () => {
    assert.deepEqual(sorted('const el = <div>{value}</div>; void el;'), ['value']);
  });

  it('reports an assignment target identifier', () => {
    assert.deepEqual(sorted('target = 1;'), ['target']);
  });

  it('does not report a member assignment target object that is declared', () => {
    assert.deepEqual(sorted('const o = {}; o.x = 1; void o;'), []);
  });

  it('reports a for-of iterable reference', () => {
    assert.deepEqual(sorted('for (const x of items) { void x; }'), ['items']);
  });

  it('resolves a for-of var binding', () => {
    assert.deepEqual(sorted('for (var x of items) {} void x;'), ['items']);
  });

  it('resolves a catch parameter', () => {
    assert.deepEqual(sorted('try {} catch (err) { void err; }'), []);
  });

  it('reports a free identifier in an arrow body', () => {
    assert.deepEqual(sorted('const f = () => external; void f;'), ['external']);
  });

  it('resolves a default parameter reference to a sibling parameter', () => {
    assert.deepEqual(sorted('function f(a, b = a) { return b; }'), []);
  });

  it('resolves a rest parameter binding', () => {
    assert.deepEqual(sorted('function f(...rest) { return rest; }'), []);
  });

  it('resolves destructured object bindings', () => {
    assert.deepEqual(sorted('const { a, b } = source; void a; void b;'), ['source']);
  });

  it('resolves destructured array bindings', () => {
    assert.deepEqual(sorted('const [a, b] = source; void a; void b;'), ['source']);
  });

  it('reports a tagged template tag reference', () => {
    assert.deepEqual(sorted('const s = tag`x`; void s;'), ['tag']);
  });

  it('reports a new-expression callee reference', () => {
    assert.deepEqual(sorted('const x = new Widget(); void x;'), ['Widget']);
  });

  it('reports an exported identifier reference', () => {
    assert.deepEqual(sorted('export { external };'), ['external']);
  });

  it('reports a bare call reference', () => {
    assert.deepEqual(sorted('doThing();'), ['doThing']);
  });

  it('resolves a shadowed reference to the inner declaration', () => {
    assert.deepEqual(sorted('const x = 1; function f() { const x = 2; return x; } void f;'), []);
  });

  it('resolves a parameter shadowing an outer free name', () => {
    assert.deepEqual(sorted('function f(external) { return external; }'), []);
  });

  it('reports a free identifier in a conditional expression', () => {
    assert.deepEqual(sorted('const x = cond ? a : b; void x;'), ['a', 'b', 'cond']);
  });

  it('reports a free identifier in an optional chain', () => {
    assert.deepEqual(sorted('const x = obj?.method(); void x;'), ['obj']);
  });

  it('reports a free identifier in a template literal expression', () => {
    assert.deepEqual(sorted('const s = `hi ${name}`; void s;'), ['name']);
  });

  it('resolves a labeled statement label', () => {
    assert.deepEqual(sorted('outer: for (;;) { break outer; }'), []);
  });

  it('reports a free identifier in a switch discriminant', () => {
    assert.deepEqual(sorted('switch (value) { case 1: break; }'), ['value']);
  });

  it('reports a free identifier in a while test', () => {
    assert.deepEqual(sorted('while (running) {}'), ['running']);
  });

  it('reports a free identifier in a throw statement', () => {
    assert.deepEqual(sorted('throw problem;'), ['problem']);
  });
});
