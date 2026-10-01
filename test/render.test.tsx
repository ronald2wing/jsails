/**
 * Renderer contract tests.
 *
 * These tests exercise the thin Preact server-rendering wrapper
 * (`src/render/render-to-string.ts`) and the Preact-backed JSX runtime. They
 * assert SSR markup and signal reactivity only — there is no DOM or
 * test-renderer installed, so actual browser hydration is not verified here.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { effect, signal, useSignal } from '@preact/signals';

import { renderToString } from '../src/render/render-to-string.js';

interface UserCardProps {
  name: string;
  age: number;
}

function UserCard({ name, age }: UserCardProps) {
  return (
    <article class="card">
      <h2>{name}</h2>
      <span>age: {age}</span>
    </article>
  );
}

function Counter() {
  const count = useSignal(0);
  return <div>count: {count.value}</div>;
}

describe('render-to-string (Preact SSR)', () => {
  it('renders TSX with typed props to SSR markup', () => {
    const html = renderToString(<UserCard name="Ada" age={36} />);
    assert.equal(html, '<article class="card"><h2>Ada</h2><span>age: 36</span></article>');
  });

  it('escapes user content inside a fragment', () => {
    const html = renderToString(<>{`<script>alert('x')</script>`}</>);
    assert.equal(html, "&lt;script>alert('x')&lt;/script>");
  });

  it('renders a useSignal counter to SSR markup', () => {
    const html = renderToString(<Counter />);
    assert.equal(html, '<div>count: 0</div>');
  });
});

describe('signals reactivity', () => {
  it('observes signal changes through an effect', () => {
    const count = signal(0);
    const seen: number[] = [];

    effect(() => {
      seen.push(count.value);
    });
    count.value = 1;
    count.value = 2;

    assert.deepEqual(seen, [0, 1, 2]);
  });
});
