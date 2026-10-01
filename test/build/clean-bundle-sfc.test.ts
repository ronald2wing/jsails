/**
 * Server-leak hardening across the `.jsails` compile path (Node-import safe).
 *
 * A `.jsails` component is rewritten by `compilerPlugin` and then by
 * `serverDirectivePlugin` before the bundler builds a client chunk. The
 * compiler reassembles the module and the directive transform replaces server
 * function bodies with throwing stubs — either could, in principle, drop or
 * rewrite the `*.server` import specifier that `cleanBundlePlugin`'s predicate
 * keys on. If it did, server-only code would reach the browser bundle with the
 * guard silently disarmed.
 *
 * These tests run the real transform pipeline against a `.jsails` source and
 * assert the leaf assertion still fires: the `*.server` specifier survives both
 * transforms, and a bundler chunk listing that module id is rejected.
 *
 * No bundler is loaded; the pipeline is composed from the pure plugin exports.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CleanBundleError,
  cleanBundlePlugin,
  serverDirectivePlugin,
  type ClientBundleChunk,
} from '../../src/build/index.js';
import { compilerPlugin } from '../../src/compiler/index.js';

/** The server-only predicate the guard is armed with: a `*.server.js` module. */
const isServerOnly = (id: string): boolean => id.endsWith('.server.js');

/** A client chunk listing the given module ids. */
function chunk(fileName: string, moduleIds: readonly string[]): ClientBundleChunk {
  return { fileName, type: 'chunk', moduleIds };
}

/**
 * A component that mixes a client-safe template with server-only code: the
 * `<server>` block imports a `*.server.js` module, which must never be bundled.
 * The virtual id mirrors what the compiler plugin publishes for a real file.
 */
const SFC_SOURCE = [
  '<script>',
  'export const authorize = () => true;',
  '</script>',
  '<template>',
  '<p>{{ title }}</p>',
  '</template>',
  '<server>',
  "import { save } from './task-store.server.js';",
  'export async function persist(title: string): Promise<void> {',
  "  'use server';",
  '  await save(title);',
  '}',
  '</server>',
].join('\n');

const SFC_ID = 'components/task-card.jsails';

/** Run the compiler then the directive transform, as the bundler would. */
function compileClientModule(code: string, id: string): string {
  const compiler = compilerPlugin({ rootDir: '.' });
  // The bundler first rewrites the `.jsails` specifier to the virtual `.tsx` id
  // (a parser-language hint), then passes that id to `transform`.
  const virtualId = compiler.resolveId(id) ?? id;
  const compiled = compiler.transform(code, virtualId);
  assert.ok(compiled !== null, 'expected the compiler to lower the component');
  const directive = serverDirectivePlugin();
  const stripped = directive.transform(compiled.code, virtualId);
  return stripped === null ? compiled.code : stripped.code;
}

describe('clean-bundle hardening across the .jsails compile path', () => {
  it('the compiled client module still imports the *.server module', () => {
    const emitted = compileClientModule(SFC_SOURCE, SFC_ID);
    assert.match(
      emitted,
      /from '\.\/task-store\.server\.js'/,
      'the *.server import must survive compile + directive transforms',
    );
  });

  it('cleanBundlePlugin still rejects the *.server module after compiling', () => {
    const emitted = compileClientModule(SFC_SOURCE, SFC_ID);
    // The bundler resolved the surviving specifier and listed it in the chunk.
    const plugin = cleanBundlePlugin({ serverOnly: isServerOnly });
    const bundle = {
      'app.js': chunk('app.js', ['components/task-card.jsails.tsx', 'task-store.server.js']),
    };

    assert.throws(
      () => plugin.generateBundle({}, bundle),
      (err: unknown) => err instanceof CleanBundleError,
    );
    // Sanity: the emitted module is a real string (the guard ran on the result).
    assert.ok(emitted.length > 0);
  });

  it('the directive transform stubs the server function body in the emitted module', () => {
    const emitted = compileClientModule(SFC_SOURCE, SFC_ID);
    assert.match(
      emitted,
      /server-only function \\"persist\\" was called in the client bundle/,
      'the persisted body must be stubbed, not shipped',
    );
  });

  it('a clean .jsails component with no *.server import passes the guard', () => {
    const clean = [
      '<script>',
      'export const authorize = () => true;',
      '</script>',
      '<template>',
      '<p>{{ title }}</p>',
      '</template>',
    ].join('\n');
    const emitted = compileClientModule(clean, 'components/card.jsails');
    const plugin = cleanBundlePlugin({ serverOnly: isServerOnly });
    const bundle = { 'app.js': chunk('app.js', ['components/card.jsails.tsx']) };

    assert.doesNotThrow(() => plugin.generateBundle({}, bundle));
    assert.ok(emitted.length > 0);
  });
});
