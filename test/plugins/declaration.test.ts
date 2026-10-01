import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PLUGIN_DECLARATION_FILENAME,
  PluginDeclarationError,
  parsePluginDeclaration,
} from '../../src/plugins/declaration.js';

describe('parsePluginDeclaration', () => {
  it('parses a minimal declaration with defaulted provides', () => {
    const declaration = parsePluginDeclaration({ id: 'jsails-auth' });
    assert.equal(declaration.id, 'jsails-auth');
    assert.deepEqual(declaration.provides, []);
    assert.equal(declaration.autoload, undefined);
    assert.equal(declaration.symbols, undefined);
    assert.equal(declaration.plugins, undefined);
  });

  it('parses the full static surface', () => {
    const declaration = parsePluginDeclaration({
      id: 'jsails-auth',
      provides: ['jsails/auth', 'jsails/auth/api-tokens'],
      autoload: { mode: 'selected', specifiers: ['jsails/auth/session'] },
      symbols: [{ name: 'resolveSessionFromRequest', specifier: 'jsails/auth' }],
      plugins: [{ id: 'acme-core' }],
    });
    assert.deepEqual(declaration.provides, ['jsails/auth', 'jsails/auth/api-tokens']);
    assert.deepEqual(declaration.autoload, {
      mode: 'selected',
      specifiers: ['jsails/auth/session'],
    });
    assert.deepEqual(declaration.symbols, [
      { name: 'resolveSessionFromRequest', specifier: 'jsails/auth' },
    ]);
    assert.deepEqual(declaration.plugins, [{ id: 'acme-core' }]);
  });

  it('rejects a non-conforming id', () => {
    assert.throws(() => parsePluginDeclaration({ id: 'Auth-Bad' }), PluginDeclarationError);
  });

  it('rejects an unknown field (strict)', () => {
    assert.throws(
      () => parsePluginDeclaration({ id: 'acme', entry: './x.js' }),
      PluginDeclarationError,
    );
  });

  it('rejects an autoload with an unknown mode', () => {
    assert.throws(
      () => parsePluginDeclaration({ id: 'acme', autoload: { mode: 'sometimes' } }),
      PluginDeclarationError,
    );
  });

  it('exposes the inert filename constant', () => {
    assert.equal(PLUGIN_DECLARATION_FILENAME, 'jsails.plugin.json');
  });
});
