/**
 * Active Storage — the `has_one_attached` attachment seam.
 *
 * {@link hasOneAttached} pairs a caller-supplied {@link Disk} (from
 * `jsails/filesystem`) with a framework-owned `jsails_attachment` table so
 * every record can carry a named file attachment without hand-writing blob
 * persistence.
 *
 * The attachment entity ({@link JsailsAttachment}) is a plain Active Record
 * entity that the portable schema model accepts. An app registers it with its
 * `JsailsDataSource` through {@link activeStorageEntities} and creates the
 * table through the normal `makemigrations`/`migrate` history, never through
 * runtime DDL. The attachment row and the disk blob are kept consistent by the
 * three methods returned from `hasOneAttached`: `attach` stores the blob on
 * the disk and persists a row, `detach` removes both, and `url` returns a
 * URL (or `null` when absent).
 *
 * Every failure is a value-free {@link ActiveStorageError}: no blob bytes,
 * disk keys, or record ids are ever echoed in a message.
 */

import { randomBytes } from 'node:crypto';

import type { DataSource } from 'typeorm';
import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import type { Disk } from '../filesystem/disk.js';

// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------

/** Table JSails reserves for Active Storage attachments. */
const ATTACHMENT_TABLE = 'jsails_attachment';

/** `jsails_attachment.<recordType|name>` column width. */
const ATTACHMENT_IDENTIFIER_LENGTH = 190;

/** `jsails_attachment.<key|contentType>` column width. */
const ATTACHMENT_VALUE_LENGTH = 255;

/** Length of the random suffix appended to every attachment key. */
const KEY_RANDOM_BYTES = 12;

@Entity(ATTACHMENT_TABLE)
export class JsailsAttachment extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: ATTACHMENT_IDENTIFIER_LENGTH, nullable: false })
  recordType!: string;

  @Column({ type: 'integer', nullable: false })
  recordId!: number;

  @Column({ type: 'varchar', length: ATTACHMENT_IDENTIFIER_LENGTH, nullable: false })
  name!: string;

  @Column({ type: 'varchar', length: ATTACHMENT_VALUE_LENGTH, nullable: false })
  key!: string;

  @Column({ type: 'varchar', length: ATTACHMENT_VALUE_LENGTH, nullable: false })
  contentType!: string;

  @Column({ type: 'integer', nullable: false })
  byteSize!: number;

  @Column({ type: 'datetime', nullable: false })
  createdAt!: Date;
}

/**
 * The entities an app must include in its `JsailsDataSource` `entities` list
 * when it uses Active Storage attachments.
 */
export const activeStorageEntities = [JsailsAttachment];

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** The attachment row the caller observes after `attach`. */
export interface Attachment {
  readonly id: number;
  readonly recordType: string;
  readonly recordId: number;
  readonly name: string;
  readonly key: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly createdAt: Date;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** Machine-readable reason for an {@link ActiveStorageError}. */
export type ActiveStorageErrorCode = 'missing_data_source' | 'disk_io';

/** Raised for every Active Storage failure that reaches a caller. Messages are value-free. */
export class ActiveStorageError extends Error {
  readonly code: ActiveStorageErrorCode;

  constructor(code: ActiveStorageErrorCode, message: string) {
    super(message);
    this.name = 'ActiveStorageError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for {@link hasOneAttached}.
 *
 * `recordType` identifies the owning entity (e.g. `'User'`) and is carried in
 * every attachment row so the same attachment `name` (e.g. `'avatar'`) can be
 * used across different entity types without collision.
 *
 * `dataSource` is the TypeORM `DataSource` that owns the `jsails_attachment`
 * table. The caller injects it explicitly — there is no global registry.
 *
 * `urlPrefix` is an optional string prepended to the blob's disk key to
 * construct a public URL (e.g. `'/uploads'` → `'/uploads/users/1/avatar_a1b2'`).
 * When omitted, `url()` returns `null`.
 */
export interface HasOneAttachedOptions {
  readonly disk: Disk;
  readonly name: string;
  readonly recordType: string;
  readonly dataSource: DataSource;
  readonly urlPrefix?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function buildKey(recordType: string, recordId: number, name: string): string {
  const rand = randomBytes(KEY_RANDOM_BYTES).toString('hex');
  return `${recordType.toLowerCase()}/${recordId}/${name}_${rand}`;
}

function toAttachment(row: JsailsAttachment): Attachment {
  return {
    id: row.id,
    recordType: row.recordType,
    recordId: row.recordId,
    name: row.name,
    key: row.key,
    contentType: row.contentType,
    byteSize: row.byteSize,
    createdAt: row.createdAt,
  };
}

/**
 * Build an attachment handle for a named attachment of a record type.
 *
 * The returned `attach` / `detach` / `url` functions scope every operation to
 * the owning `recordType` and attachment `name`, so the per-call `record`
 * argument carries only the record's numeric id.
 */
export function hasOneAttached(options: HasOneAttachedOptions) {
  const { disk, name, recordType, dataSource, urlPrefix } = options;

  const repository = dataSource.getRepository(JsailsAttachment);

  const findRow = (recordId: number) => repository.findOneBy({ recordType, recordId, name });

  const attach = async (
    record: { id: number },
    data: Uint8Array,
    contentType: string,
  ): Promise<Attachment> => {
    const key = buildKey(recordType, record.id, name);

    await disk.put(key, data, { contentType });

    const row = repository.create({
      recordType,
      recordId: record.id,
      name,
      key,
      contentType,
      byteSize: data.byteLength,
      createdAt: new Date(),
    });

    const saved = await repository.save(row);

    return toAttachment(saved);
  };

  const detach = async (record: { id: number }): Promise<void> => {
    const row = await findRow(record.id);
    if (!row) {
      return;
    }

    await disk.delete(row.key);
    await repository.remove(row);
  };

  const url = async (record: { id: number }): Promise<string | null> => {
    const row = await findRow(record.id);
    if (!row) {
      return null;
    }
    if (!urlPrefix) {
      return null;
    }
    return `${urlPrefix}/${row.key}`;
  };

  return { attach, detach, url };
}
