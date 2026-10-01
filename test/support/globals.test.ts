import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { installFrameworkSymbols } from '../../src/symbols/install-server.js';
import { deriveFrameworkSymbols } from '../../src/symbols/framework-symbol-catalog-scan.js';
import { loadFrameworkAutoloadDeclaration } from '../../src/compiler/plugin-declaration-scan.js';

/** The repo root, so the scan reads the framework's own `src/` barrels. */
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** The framework's curated autoload surface, read from `jsails.plugin.json`. */
const frameworkGlobals = loadFrameworkAutoloadDeclaration(repoRoot);

// The eight browser-safe core namespaces and their eight error classes.
const CORE_NAMESPACES = ['Str', 'Num', 'Time', 'Arr', 'Async', 'Encoding', 'Url', 'Cryptography'];
const CORE_ERRORS = [
  'StrError',
  'NumError',
  'TimeError',
  'ArrError',
  'AsyncError',
  'EncodingError',
  'UrlError',
  'CryptographyError',
];

// The server-only addendum namespaces and their error classes.
const SERVER_NAMESPACES = ['Files', 'Media', 'Cookie'];
const SERVER_ERRORS = ['FilesError', 'MediaError', 'CookieError'];
const SERVER_TOP_LEVEL = ['parseFrontmatter', 'serializeError'];

function globals(): Record<string, unknown> {
  return globalThis;
}

/** Install the curated framework table over the repo's own barrels. */
async function install(): Promise<void> {
  const catalog = deriveFrameworkSymbols({
    rootDir: repoRoot,
    declaration: frameworkGlobals,
  });
  await installFrameworkSymbols(repoRoot, { globals: catalog, onWarn: () => {} });
}

describe('support globals projection', () => {
  it('projects the compiled support suite onto globalThis', async () => {
    await install();
    for (const name of [...CORE_NAMESPACES, ...CORE_ERRORS]) {
      assert.notEqual(globals()[name], undefined, `${name} missing from globalThis`);
    }
    for (const name of [...SERVER_NAMESPACES, ...SERVER_ERRORS, ...SERVER_TOP_LEVEL]) {
      assert.notEqual(globals()[name], undefined, `${name} missing from globalThis`);
    }
  });

  it('the bare Cryptography global is the single coherent async surface', async () => {
    await install();
    const Cryptography = globals()['Cryptography'] as Record<string, unknown>;
    assert.notEqual(Cryptography, undefined);
    // One surface: the async browser-safe surface (no sync hashSync/timingSafeEqual
    // on the bare global — those are server-only, imported under distinct names).
    assert.equal(typeof Cryptography['hash'], 'function');
    assert.equal(Cryptography['hashSync'], undefined);
    assert.equal(Cryptography['timingSafeEqual'], undefined);
  });

  it('the server does not park a shadowing Cryptography superset', async () => {
    await install();
    const Cryptography = globals()['Cryptography'] as Record<string, unknown>;
    const server = globals()['server'] as Record<string, unknown> | undefined;
    assert.notEqual(server, undefined, 'server collision namespace missing');
    if (server === undefined) return;
    // The `server` namespace parks the colliding specifier, but its Cryptography
    // is the SAME coherent object — not a shadow superset.
    const parked = server['Cryptography'] as Record<string, unknown>;
    assert.equal(parked, Cryptography);
    assert.equal(parked['timingSafeEqual'], undefined);
    // The distinct server names are projected as bare globals instead.
    assert.equal(typeof globals()['hashSync'], 'function');
    assert.equal(typeof globals()['hmacSync'], 'function');
    assert.equal(typeof globals()['timingSafeEqual'], 'function');
    assert.notEqual(globals()['ServerCryptography'], undefined);
  });

  it('is idempotent: a second install adds no new globals', async () => {
    await install();
    const before = Object.keys(globals()).length;
    await install();
    assert.equal(Object.keys(globals()).length, before);
  });
});
