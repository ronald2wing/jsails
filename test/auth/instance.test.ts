/**
 * Disposal tests for the first-party `auth` instance seam.
 *
 * These prove that a Better Auth instance releases its Kysely connection pool
 * exactly once, without a database, by driving the extracted {@link attachDispose}
 * helper directly with a fake `destroy` function. The live-DB path — building a
 * real memoized instance through {@link createAuth} and disposing it — is not
 * exercised here because Better Auth's runtime schema check introspects the
 * database at construction time (opening a real connection); see the note on the
 * memo-clear test below.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  attachDispose,
  AuthDisposeError,
  disposeCachedAuth,
  type Auth,
} from '../../src/auth/instance.js';

/** A deferred promise used to gate the fake destroy until the test resolves it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('attachDispose', () => {
  it('attaches a non-enumerable dispose method', () => {
    const auth = attachDispose({} as Auth, async () => {});
    assert.equal(typeof auth.dispose, 'function');
    assert.equal(Object.prototype.propertyIsEnumerable.call(auth, 'dispose'), false);
  });

  it('runs the underlying destroy exactly once on the first dispose', async () => {
    let calls = 0;
    const auth = attachDispose({} as Auth, async () => {
      calls += 1;
    });

    await auth.dispose();
    assert.equal(calls, 1);
  });

  it('does not re-run destroy on a second dispose', async () => {
    let calls = 0;
    const auth = attachDispose({} as Auth, async () => {
      calls += 1;
    });

    await auth.dispose();
    await auth.dispose();
    assert.equal(calls, 1);
  });

  it('shares one destroy across concurrent dispose calls', async () => {
    let calls = 0;
    const gate = deferred();
    const auth = attachDispose({} as Auth, async () => {
      calls += 1;
      await gate.promise;
    });

    const first = auth.dispose();
    const second = auth.dispose();
    gate.resolve();
    await Promise.all([first, second]);

    assert.equal(calls, 1);
  });

  it('surfaces a value-free AuthDisposeError when destroy rejects', async () => {
    const auth = attachDispose({} as Auth, async () => {
      throw new Error('root:secret@db.internal:3306/auth');
    });

    await assert.rejects(auth.dispose(), (error: unknown) => {
      assert.ok(error instanceof AuthDisposeError);
      assert.equal(error.message, 'Failed to release the auth database connection pool');
      // The message is fixed and never echoes the DSN, host, user, or password.
      assert.ok(!error.message.includes('root'));
      assert.ok(!error.message.includes('secret'));
      assert.ok(!error.message.includes('db.internal'));
      assert.ok(!error.message.includes('3306'));
      return true;
    });
  });

  it('clears the memo once after a successful dispose', async () => {
    let cleared = 0;
    const auth = attachDispose(
      {} as Auth,
      async () => {},
      () => {
        cleared += 1;
      },
    );

    await auth.dispose();
    assert.equal(cleared, 1);

    // Idempotent: the second dispose shares the first call's promise and does
    // not run the memo clear a second time.
    await auth.dispose();
    assert.equal(cleared, 1);
  });

  it('does not clear the memo when dispose fails', async () => {
    let cleared = 0;
    const auth = attachDispose(
      {} as Auth,
      async () => {
        throw new Error('boom');
      },
      () => {
        cleared += 1;
      },
    );

    await assert.rejects(auth.dispose(), AuthDisposeError);
    assert.equal(cleared, 0);
  });
});

describe('disposeCachedAuth', () => {
  it('is a no-op when the memoized instance was never built', async () => {
    // No `createAuth()` call runs in this suite, so the module memo is empty;
    // disposing must neither throw nor open a connection.
    await assert.doesNotReject(disposeCachedAuth());
  });

  // NOTE (live-DB gap): the full "dispose then `createAuth()` returns a NEW
  // object" contract is not asserted here because building a real memoized
  // instance requires Better Auth to introspect MariaDB at construction (its
  // runtime schema check), which needs a live connection. The memo-clear wiring
  // is the `clearMemo` callback (`cachedAuth = undefined`), and its
  // exactly-once invocation is covered by the `attachDispose` memo tests above;
  // the end-to-end disposal is covered by the `auth` plugin's close test and the
  // starter's live `auth:migrate` journey.
});
