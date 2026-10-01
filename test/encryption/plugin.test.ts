/**
 * Encryption plugin tests: service wiring through the extension runner, key
 * validation, and inert construction. No connection, database, or external
 * service is opened.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runExtensions } from '../../src/extensions/index.js';
import { EncryptionError } from '../../src/encryption/errors.js';
import { encryptionPlugin, encryptionToken } from '../../src/encryption/plugin.js';
import type { Encrypter } from '../../src/encryption/types.js';

// -- helpers ------------------------------------------------------------------

const KEY = 'k'.repeat(32);

/** Resolve an encrypter from a plugin and return it with a teardown. */
async function pluginEncrypter(
  options: Parameters<typeof encryptionPlugin>[0],
): Promise<{ encrypter: Encrypter; close(): Promise<void> }> {
  const runtime = await runExtensions([encryptionPlugin(options)]);
  const encrypter: Encrypter = runtime.services.get(encryptionToken);
  return { encrypter, close: () => runtime.close() };
}

describe('encryptionPlugin', () => {
  it('has name "encryption" and a stable token', () => {
    assert.equal(encryptionToken.name, 'encryption');
    assert.equal(encryptionPlugin({ key: KEY }).name, 'encryption');
  });

  it('provides an Encrypter service under the token', async () => {
    const { encrypter, close } = await pluginEncrypter({ key: KEY });
    try {
      assert.equal(typeof encrypter.encrypt, 'function');
      assert.equal(typeof encrypter.decrypt, 'function');
    } finally {
      await close();
    }
  });

  it('the provided encrypter round-trips a value', async () => {
    const { encrypter, close } = await pluginEncrypter({ key: KEY });
    try {
      const token = encrypter.encrypt('plugin secret');
      assert.equal(encrypter.decrypt(token), 'plugin secret');
    } finally {
      await close();
    }
  });

  it('a consumer extension can require the encryption token', async () => {
    const consumer = {
      name: 'consumer',
      requires: [encryptionToken],
      setup({ services }: { services: { get(token: typeof encryptionToken): Encrypter } }) {
        const encrypter = services.get(encryptionToken);
        const token = encrypter.encrypt('via requires');
        assert.equal(encrypter.decrypt(token), 'via requires');
      },
    };

    const runtime = await runExtensions([encryptionPlugin({ key: KEY }), consumer]);
    await runtime.close();
  });

  it('construction is inert — encryptionPlugin() performs no crypto', () => {
    const plugin = encryptionPlugin({ key: KEY });
    assert.equal(typeof plugin.name, 'string');
    assert.equal(typeof plugin.setup, 'function');
  });
});

describe('option validation', () => {
  it('throws EncryptionError for a short key during setup', async () => {
    await assert.rejects(
      async () => {
        const runtime = await runExtensions([encryptionPlugin({ key: 'short' })]);
        await runtime.close();
      },
      (err: unknown) => {
        assert.ok(err instanceof EncryptionError);
        assert.equal(err.code, 'invalid_key');
        // The message must not echo the key value.
        assert.ok(!err.message.includes('short'));
        return true;
      },
    );
  });
});

describe('idempotent close', () => {
  it('closes idempotently with no handles held', async () => {
    const runtime = await runExtensions([encryptionPlugin({ key: KEY })]);
    await runtime.close();
    await runtime.close();
  });
});
