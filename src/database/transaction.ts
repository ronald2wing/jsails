/**
 * Transaction wrapper for JSails data sources.
 *
 * {@link transaction} wraps TypeORM's built-in `DataSource.manager.transaction`
 * and adds a per-call {@link TransactionHandle} with `afterCommit` /
 * `afterRollback` callbacks. An {@link AsyncLocalStorage} map keyed by data
 * source tracks active transactions so nested calls join the outer scope.
 *
 * ## Semantics (the contract)
 *
 * 1. **Wrapper around TypeORM.** `transaction` calls
 *    `dataSource.manager.transaction(async (manager) => ...)` internally. The
 *    body runs inside a TypeORM transaction; on success the transaction
 *    commits, and on failure (body throw) it rolls back.
 *
 * 2. **Transaction-scoped manager.** The body receives a
 *    {@link TransactionHandle} whose `manager` is the **transaction-scoped**
 *    `EntityManager`, not the raw data source's manager. Accessing `handle.manager`
 *    outside the body throws a {@link TransactionError}.
 *
 * 3. **Per-call callback arrays.** `afterCommit` / `afterRollback` store
 *    callbacks in arrays local to this `transaction()` call. They are never
 *    shared across calls.
 *
 * 4. **Success path: commit then callbacks.** When the body resolves, the
 *    transaction commits, then `afterCommit` callbacks run **awaited, in
 *    registration order**, then `transaction()` resolves with the body's
 *    return value.
 *
 *    **If an `afterCommit` callback throws,** the error propagates and
 *    **replaces** the body's resolved value. The transaction already committed
 *    — any writes it made are durable, but the caller only sees the callback
 *    error. Remaining `afterCommit` callbacks do NOT run after a throw.
 *
 * 5. **Failure path: rollback then callbacks.** When the body throws,
 *    TypeORM rolls back the transaction, then `afterRollback` callbacks run
 *    **awaited, in registration order**, then the **original body error is
 *    re-thrown unchanged**.
 *
 *    **A throwing `afterRollback` callback is swallowed.** Post-mortem cleanup
 *    must not mask the original cause. The remaining `afterRollback` callbacks
 *    still run; only the body error propagates outward.
 *
 * 6. **`TransactionError`** is for the wrapper's OWN construction/usage errors
 *    (invalid `dataSource` or non-function `body` argument). Messages are
 *    value-free — they never echo the invalid input. Body failures propagate
 *    as the caller's own error, never wrapped.
 *
 * 7. **Nested `transaction()` calls join the outer transaction.** When
 *    `transaction(dataSource, body)` is called inside an existing transaction
 *    body for the **same** `JsailsDataSource` (same object identity), the
 *    nested call joins the outer transaction:
 *
 *    - No new TypeORM transaction is opened.
 *    - The nested body receives a handle whose `manager` is the outer
 *      transaction's manager.
 *    - `afterCommit` / `afterRollback` callbacks registered inside the nested
 *      body are appended to the **outer scope's** callback arrays. They fire
 *      **once**, at the outermost commit or rollback, in registration order
 *      (outer-registered first, then inner).
 *    - A nested body throw propagates through the nested call. If uncaught by
 *      the outer body, it triggers a rollback of the entire outer transaction.
 *    - If the outer transaction commits, all accumulated `afterCommit`
 *      callbacks fire; none of the `afterRollback` callbacks fire. If it rolls
 *      back, all `afterRollback` callbacks fire; none of the `afterCommit`
 *      callbacks fire.
 *
 *    When called for a **different** `JsailsDataSource`, the nested call opens
 *    its **own independent transaction** — a separate TypeORM transaction with
 *    its own commit / rollback lifecycle and its own callback arrays. Its scope
 *    is tracked in the same ALS map so further nesting can join either data
 *    source's transaction.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { EntityManager } from 'typeorm';

import type { Awaitable } from '../internal/types.js';
import { JsailsDataSource } from './data-source.js';

/**
 * A per-call handle available inside the transaction body.
 *
 * `manager` is the transaction-scoped {@link EntityManager}. Accessing it
 * outside the body throws a {@link TransactionError}.
 */
export interface TransactionHandle {
  readonly manager: EntityManager;
  afterCommit(callback: TransactionCallback): void;
  afterRollback(callback: TransactionCallback): void;
}

/** An async-or-sync callback run on commit or rollback. */
export type TransactionCallback = () => Awaitable<void>;

/** The function body of a transaction, receiving the per-call handle. */
export type TransactionBody<R> = (handle: TransactionHandle) => Promise<R>;

/** Raised for invalid arguments to {@link transaction}. Messages are value-free. */
export class TransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionError';
  }
}

/**
 * Per-data-source transaction scope tracked inside the ALS map.
 * Not exported — nesting is behaviour, not a public surface.
 */
interface TransactionScope {
  txManager: EntityManager;
  afterCommitCallbacks: TransactionCallback[];
  afterRollbackCallbacks: TransactionCallback[];
}

/** ALS map keyed by data source identity so nested calls join the right scope. */
const als = new AsyncLocalStorage<Map<JsailsDataSource, TransactionScope>>();

/** Build a handle that delegates to a scope's callback arrays and manager. */
function createHandle(scope: TransactionScope): TransactionHandle {
  return {
    get manager(): EntityManager {
      if (!scope.txManager) {
        throw new TransactionError(
          'transaction handle manager is only available inside the transaction body',
        );
      }
      return scope.txManager;
    },
    afterCommit(callback: TransactionCallback): void {
      scope.afterCommitCallbacks.push(callback);
    },
    afterRollback(callback: TransactionCallback): void {
      scope.afterRollbackCallbacks.push(callback);
    },
  };
}

/**
 * Run the TypeORM transaction and callback lifecycle for a scope.
 *
 * The scope's `txManager` is set inside the TypeORM callback so the handle
 * getter can guard access. Commit / rollback paths run the scope's own
 * callback arrays (which may include callbacks from joined nested calls).
 */
async function runScopedTransaction<R>(
  dataSource: JsailsDataSource,
  scope: TransactionScope,
  body: TransactionBody<R>,
): Promise<R> {
  let result: R;
  try {
    result = await dataSource.manager.transaction(async (manager) => {
      scope.txManager = manager;
      return await body(createHandle(scope));
    });
  } catch (error) {
    // Transaction rolled back — run afterRollback callbacks.
    // A throwing callback is swallowed: post-mortem cleanup must not mask
    // the original cause. The remaining callbacks still run.
    for (const cb of scope.afterRollbackCallbacks) {
      try {
        await cb();
      } catch {
        // swallowed
      }
    }
    throw error;
  }

  // Transaction committed — run afterCommit callbacks in registration order.
  // This is outside the try/catch above on purpose: a throwing afterCommit
  // callback must NOT trigger afterRollback, because the commit already
  // happened. If one throws, the error propagates and the body result is lost
  // (the writes are durable).
  for (const cb of scope.afterCommitCallbacks) {
    await cb();
  }

  return result;
}

/**
 * Run `body` inside a TypeORM transaction, then fire registered `afterCommit`
 * or `afterRollback` callbacks.
 *
 * @param dataSource - A constructed {@link JsailsDataSource}. Must be an
 *   instance of that class — anything else throws {@link TransactionError}.
 * @param body - A function receiving a {@link TransactionHandle} whose
 *   `manager` is the transaction-scoped `EntityManager`. Must be callable —
 *   a non-function throws {@link TransactionError}.
 * @returns The value the body resolved with, after any `afterCommit`
 *   callbacks have completed.
 * @throws The body's own error (on rollback), or the error from a throwing
 *   `afterCommit` callback (after commit).
 */
export async function transaction<R>(
  dataSource: JsailsDataSource,
  body: TransactionBody<R>,
): Promise<R> {
  if (!(dataSource instanceof JsailsDataSource)) {
    throw new TransactionError('transaction requires a JsailsDataSource instance');
  }
  if (typeof body !== 'function') {
    throw new TransactionError('transaction requires a function body');
  }

  const store = als.getStore();

  if (store) {
    // Nested call — check whether this data source already has a scope.
    const existing = store.get(dataSource);
    if (existing) {
      // Same data source: join the outer transaction. The nested body
      // receives the outer manager and its callbacks are appended to the
      // outer scope's arrays so they fire once at the outermost boundary.
      return await body(createHandle(existing));
    }

    // Different data source: open an independent transaction. Its scope
    // is tracked in the shared ALS map so further nesting can join either
    // data source's transaction.
    const scope: TransactionScope = {
      txManager: undefined as unknown as EntityManager,
      afterCommitCallbacks: [],
      afterRollbackCallbacks: [],
    };
    store.set(dataSource, scope);
    try {
      return await runScopedTransaction(dataSource, scope, body);
    } finally {
      // Clean up the scope so no one joins a completed transaction.
      store.delete(dataSource);
    }
  }

  // Outermost call — create the ALS map and run inside it so all nested
  // calls discover the scope.
  const map = new Map<JsailsDataSource, TransactionScope>();
  const scope: TransactionScope = {
    txManager: undefined as unknown as EntityManager,
    afterCommitCallbacks: [],
    afterRollbackCallbacks: [],
  };
  map.set(dataSource, scope);

  return await als.run(map, () => runScopedTransaction(dataSource, scope, body));
}
