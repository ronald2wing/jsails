/**
 * Database-backed {@link SessionStore}.
 *
 * {@link DatabaseSessionStoreImpl} persists sessions in the framework-owned
 * `jsails_session` table through the injected TypeORM `DataSource`'s repository
 * — no raw SQL and no runtime DDL. The table must already exist: an app includes
 * {@link sessionEntities} in its `JsailsDataSource` entities and creates the
 * table through the normal declarative schema history (`db:push`). A missing table
 * fails with a clear, value-free {@link SessionStoreError} telling the caller to
 * run those commands; the store never creates it. A data source that is not
 * initialized fails with a clear error before any repository query runs.
 *
 * A session row stores the full session — id, CSRF token, session data, and
 * millisecond expiry — as JSON in `data`, with `sessionId` and `expiresAt`
 * denormalized into scalar columns for lookup and expiry pruning. Reads parse
 * and validate that JSON value-free: a malformed row (invalid JSON, a shape
 * that is not a session, or a stored id that disagrees with the `sessionId`
 * column) is rejected without ever echoing its contents. Expired rows are
 * deleted lazily on {@link get} and in bulk by {@link pruneExpired}; expiry is
 * judged against the reconstructed session's millisecond expiry so it never
 * depends on a driver's datetime precision.
 */

import type { DataSource, Repository } from 'typeorm';
import { LessThanOrEqual } from 'typeorm';

import type { Session, SessionStore } from '../contracts/http.js';
import { JsailsSession, SESSION_ID_COLUMN_LENGTH, SESSION_TABLE } from './entity.js';

/** Raised for a missing/uninitialized table, an invalid write, or a malformed row. */
export class SessionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionStoreError';
  }
}

/** Options for {@link DatabaseSessionStoreImpl}. */
export interface DatabaseSessionStoreOptions {
  /** The initialized TypeORM data source backing sessions. */
  readonly dataSource: DataSource;
  /** Monotonic-ish time source returning epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** A {@link SessionStore} that also exposes best-effort expiry pruning. */
export interface DatabaseSessionStore extends SessionStore {
  /** Delete every row whose `expiresAt` is at or before now; returns the count. */
  pruneExpired(): Promise<number>;
}

/**
 * Whether `value` is a non-null, non-array object. Intentionally looser than the
 * internal `isPlainObject` (which rejects class instances): this check accepts
 * any object shape, so it must not be swapped for the strict helper.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural check of a parsed/JSON value as a {@link Session}. Value-free. */
function isSessionValue(value: unknown): value is Session {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= SESSION_ID_COLUMN_LENGTH &&
    typeof value.csrfToken === 'string' &&
    value.csrfToken.length > 0 &&
    isRecord(value.data) &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt)
  );
}

/** Validate and serialize an inbound {@link Session}, value-free. */
function serializeSession(session: Session): string {
  if (!isSessionValue(session)) {
    throw new SessionStoreError('session store received an invalid session');
  }
  try {
    return JSON.stringify(session);
  } catch {
    throw new SessionStoreError('session store received a session that is not JSON-serializable');
  }
}

/** Parse and validate a stored row's `data` JSON into a {@link Session}, value-free. */
function parseSessionRow(row: JsailsSession): Session {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.data);
  } catch {
    throw new SessionStoreError('session store encountered a malformed session row');
  }
  if (!isSessionValue(parsed) || parsed.id !== row.sessionId) {
    throw new SessionStoreError('session store encountered a malformed session row');
  }
  return parsed;
}

/**
 * Database-backed {@link SessionStore} over an initialized TypeORM data source.
 * The `jsails_session` table must already exist (created by the migration
 * history). See the module doc for the exact contract.
 */
export class DatabaseSessionStoreImpl implements DatabaseSessionStore {
  readonly #dataSource: DataSource;
  readonly #now: () => number;
  readonly #repository: Repository<JsailsSession>;

  constructor(options: DatabaseSessionStoreOptions) {
    const dataSource = options.dataSource;
    if (!(dataSource instanceof Object)) {
      throw new TypeError('database session store requires a data source');
    }
    this.#dataSource = dataSource;
    this.#now = options.now ?? Date.now;
    this.#repository = dataSource.getRepository(JsailsSession);
  }

  /** Fail with a clear error when the table is missing; never create it. */
  async #assertTableExists(): Promise<void> {
    if (!this.#dataSource.isInitialized) {
      throw new SessionStoreError('the session data source must be initialized');
    }
    const queryRunner = this.#dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      if (!(await queryRunner.hasTable(SESSION_TABLE))) {
        throw new SessionStoreError(
          'the jsails_session table does not exist; run db:push to create it',
        );
      }
    } finally {
      await queryRunner.release();
    }
  }

  async get(id: string): Promise<Session | null> {
    await this.#assertTableExists();
    const row = await this.#repository.findOneBy({ sessionId: id });
    if (row === null) {
      return null;
    }
    const session = parseSessionRow(row);
    if (session.expiresAt <= this.#now()) {
      await this.#repository.delete({ id: row.id });
      return null;
    }
    return session;
  }

  async set(session: Session): Promise<void> {
    const serialized = serializeSession(session);
    await this.#assertTableExists();
    await this.#dataSource.transaction(async (manager) => {
      const transactionRepository = manager.getRepository(JsailsSession);
      const existing = await transactionRepository.findOneBy({ sessionId: session.id });
      if (existing !== null) {
        existing.data = serialized;
        existing.expiresAt = new Date(session.expiresAt);
        await transactionRepository.save(existing);
        return;
      }
      await transactionRepository.save(
        transactionRepository.create({
          sessionId: session.id,
          data: serialized,
          expiresAt: new Date(session.expiresAt),
          createdAt: new Date(this.#now()),
        }),
      );
    });
  }

  async delete(id: string): Promise<void> {
    await this.#assertTableExists();
    await this.#repository.delete({ sessionId: id });
  }

  async pruneExpired(): Promise<number> {
    await this.#assertTableExists();
    const result = await this.#repository.delete({
      expiresAt: LessThanOrEqual(new Date(this.#now())),
    });
    return result.affected ?? 0;
  }
}
