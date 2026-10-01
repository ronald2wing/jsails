/**
 * Turbo Stream message builder tests (Node-import safe).
 *
 * Every function is a pure string builder with no DOM, no Node imports, and no
 * `@hotwired/turbo` dependency, so the test suite runs in plain Node without a
 * browser.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  appendStream,
  beforeStream,
  afterStream,
  prependStream,
  refreshStream,
  removeStream,
  replaceStream,
  updateStream,
  turboStreamMessage,
} from '../../src/client/streams.js';

describe('turboStreamMessage', () => {
  it('builds an append message', () => {
    const result = turboStreamMessage('append', 'list', '<li>x</li>');
    assert.equal(
      result,
      '<turbo-stream action="append" target="list"><template><li>x</li></template></turbo-stream>',
    );
  });

  it('builds a replace message', () => {
    const result = turboStreamMessage('replace', 'box', '<div>hi</div>');
    assert.equal(
      result,
      '<turbo-stream action="replace" target="box"><template><div>hi</div></template></turbo-stream>',
    );
  });

  it('builds an update message', () => {
    const result = turboStreamMessage('update', 'box', '<span>ok</span>');
    assert.equal(
      result,
      '<turbo-stream action="update" target="box"><template><span>ok</span></template></turbo-stream>',
    );
  });

  it('builds a remove message with no template', () => {
    const result = turboStreamMessage('remove', 'el');
    assert.equal(result, '<turbo-stream action="remove" target="el"></turbo-stream>');
  });

  it('ignores html for remove', () => {
    const result = turboStreamMessage('remove', 'el', 'ignored');
    assert.equal(result, '<turbo-stream action="remove" target="el"></turbo-stream>');
  });

  it('builds a refresh message (no template)', () => {
    const result = turboStreamMessage('refresh', 'el');
    assert.equal(result, '<turbo-stream action="refresh" target="el"></turbo-stream>');
  });

  it('ignores html for refresh', () => {
    const result = turboStreamMessage('refresh', 'el', '<div>ignored</div>');
    assert.equal(result, '<turbo-stream action="refresh" target="el"></turbo-stream>');
  });

  it('throws for missing html on a non-remove action', () => {
    assert.throws(() => turboStreamMessage('replace', 'el'), TypeError);
  });

  it('throws for whitespace in target', () => {
    assert.throws(() => turboStreamMessage('append', 'bad id', 'x'), TypeError);
  });

  it('throws for an unknown action', () => {
    assert.throws(() => turboStreamMessage('invalid', 'el', 'x'), TypeError);
  });

  it('throws for an empty target', () => {
    assert.throws(() => turboStreamMessage('replace', '', 'x'), TypeError);
  });

  it('throws for a target with a quote', () => {
    assert.throws(() => turboStreamMessage('replace', 'a"b', 'x'), TypeError);
  });

  it('throws for a target with angle brackets', () => {
    assert.throws(() => turboStreamMessage('replace', '<a>', 'x'), TypeError);
  });
});

describe('convenience helpers', () => {
  it('appendStream delegates correctly', () => {
    assert.equal(
      appendStream('list', '<li>x</li>'),
      '<turbo-stream action="append" target="list"><template><li>x</li></template></turbo-stream>',
    );
  });

  it('removeStream delegates correctly', () => {
    assert.equal(removeStream('el'), '<turbo-stream action="remove" target="el"></turbo-stream>');
  });

  it('refreshStream delegates correctly', () => {
    assert.equal(refreshStream('el'), '<turbo-stream action="refresh" target="el"></turbo-stream>');
  });

  it('replaceStream delegates correctly', () => {
    assert.equal(
      replaceStream('box', '<div>x</div>'),
      '<turbo-stream action="replace" target="box"><template><div>x</div></template></turbo-stream>',
    );
  });

  it('updateStream delegates correctly', () => {
    assert.equal(
      updateStream('box', '<span>x</span>'),
      '<turbo-stream action="update" target="box"><template><span>x</span></template></turbo-stream>',
    );
  });

  it('prependStream delegates correctly', () => {
    assert.equal(
      prependStream('list', '<li>x</li>'),
      '<turbo-stream action="prepend" target="list"><template><li>x</li></template></turbo-stream>',
    );
  });

  it('beforeStream delegates correctly', () => {
    assert.equal(
      beforeStream('el', '<div>x</div>'),
      '<turbo-stream action="before" target="el"><template><div>x</div></template></turbo-stream>',
    );
  });

  it('afterStream delegates correctly', () => {
    assert.equal(
      afterStream('el', '<div>x</div>'),
      '<turbo-stream action="after" target="el"><template><div>x</div></template></turbo-stream>',
    );
  });
});
