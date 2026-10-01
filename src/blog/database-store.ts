/**
 * Database-backed {@link BlogPostStore}.
 *
 * {@link createDatabaseBlogStore} persists posts in the framework-owned
 * `jsails_blog_post` table through the injected TypeORM `DataSource`'s
 * repository — no raw SQL and no runtime DDL. The table must already exist: an
 * app includes {@link blogPostEntities} in its `JsailsDataSource` entities and
 * creates the table through the normal `makemigrations`/`migrate` history. A
 * missing table fails with a clear, value-free {@link BlogStoreError} telling
 * the caller to run those commands; the store never creates it.
 *
 * The data source is resolved lazily and initialized on first use when it is
 * not already initialized, so a config can build the store over a
 * `getDataSource` thunk that reads environment variables and constructs (but
 * does not connect) the source only once a query actually runs. Initialization
 * is idempotent: concurrent first uses share one `initialize()` promise.
 *
 * The entity is the single source of truth for the table shape: a generated
 * integer primary key plus `title`/`slug` (varchar 190), `body` (text),
 * `published` (boolean), and `createdAt`/`updatedAt` (datetime) scalar columns.
 * `slug` is derived from the title on every write; `published` is always `true`
 * on write (there is no unpublish surface yet) and `list` filters on it, so a
 * row marked unpublished by another path is hidden from the public list.
 * `createdAt`/`updatedAt` have no database default; the store sets them from
 * application code (an injectable `now` clock for tests). The `events` and
 * `recordEvent` surface is runtime-only (an in-memory per-store array), never
 * persisted: the `blog.post.created` observer records events for the lifetime
 * of one store instance.
 */

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { DataSource, Repository } from 'typeorm';

import type { BlogPost, BlogPostCreatedEvent, BlogPostInput, BlogPostStore } from './plugin.js';

/** Table JSails reserves for database-backed blog posts. */
export const BLOG_POST_TABLE = 'jsails_blog_post';

/** `jsails_blog_post.title` column width. */
export const BLOG_POST_TITLE_LENGTH = 190;

/** `jsails_blog_post.slug` column width. */
export const BLOG_POST_SLUG_LENGTH = 190;

@Entity(BLOG_POST_TABLE)
export class JsailsBlogPost extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: BLOG_POST_TITLE_LENGTH, nullable: false })
  title!: string;

  @Column({ type: 'varchar', length: BLOG_POST_SLUG_LENGTH, nullable: false })
  slug!: string;

  @Column({ type: 'text', nullable: false })
  body!: string;

  @Column({ type: 'boolean', nullable: false })
  published!: boolean;

  @Column({ type: 'datetime', nullable: false })
  createdAt!: Date;

  @Column({ type: 'datetime', nullable: false })
  updatedAt!: Date;
}

/**
 * The entities an app must include in its `JsailsDataSource` `entities` list
 * when it persists blog posts in the database.
 */
export const blogPostEntities = [JsailsBlogPost];

/** Raised for a missing/uninitialized table or an invalid write. */
export class BlogStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlogStoreError';
  }
}

/** Options for {@link createDatabaseBlogStore}. */
export interface DatabaseBlogStoreOptions {
  /**
   * The TypeORM data source backing blog posts. Provide either this or
   * `getDataSource`; the store initializes the source on first use when it is
   * not already initialized.
   */
  readonly dataSource?: DataSource;
  /**
   * Resolve the data source lazily on first use. Prefer this when constructing
   * the source reads environment variables (or otherwise must not run at config
   * import time); the thunk runs once, on the first query. Takes precedence
   * over `dataSource`.
   */
  readonly getDataSource?: () => DataSource;
  /** Monotonic-ish time source. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

/** True for a value with the TypeORM `DataSource` surface the store uses. */
function isDataSource(value: unknown): value is DataSource {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { getRepository?: unknown }).getRepository === 'function' &&
    typeof (value as { initialize?: unknown }).initialize === 'function'
  );
}

/** Derive a URL slug from a title; falls back to a fixed value when empty. */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, BLOG_POST_SLUG_LENGTH);
  return slug === '' ? 'post' : slug;
}

/** Map an entity row to the public {@link BlogPost} shape (`createdAt` as ISO). */
function toBlogPost(row: JsailsBlogPost): BlogPost {
  return { id: row.id, title: row.title, body: row.body, createdAt: row.createdAt.toISOString() };
}

/**
 * Build a database-backed {@link BlogPostStore} over a TypeORM data source. The
 * `jsails_blog_post` table must already exist (created by the migration
 * history). The data source is resolved lazily (via `getDataSource`, else
 * `dataSource`) and initialized on first use when needed. See the module doc for
 * the exact contract.
 */
export function createDatabaseBlogStore(options: DatabaseBlogStoreOptions): BlogPostStore {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createDatabaseBlogStore requires an options object');
  }
  if (options.dataSource === undefined && options.getDataSource === undefined) {
    throw new TypeError('createDatabaseBlogStore requires a dataSource or getDataSource');
  }
  if (options.getDataSource !== undefined && typeof options.getDataSource !== 'function') {
    throw new TypeError('getDataSource must be a function');
  }

  const resolveDataSource = options.getDataSource ?? (() => options.dataSource);
  const now = options.now ?? (() => new Date());
  const events: BlogPostCreatedEvent[] = [];

  let dataSource: DataSource | undefined;
  let initializing: Promise<DataSource> | undefined;
  let repository: Repository<JsailsBlogPost> | undefined;

  /** Resolve and (idempotently) initialize the data source on first use. */
  async function ensureReady(): Promise<{
    source: DataSource;
    repository: Repository<JsailsBlogPost>;
  }> {
    if (dataSource === undefined) {
      const resolved = resolveDataSource();
      if (!isDataSource(resolved)) {
        throw new BlogStoreError('the blog data source must be a TypeORM data source');
      }
      dataSource = resolved;
    }
    const source = dataSource;
    if (!source.isInitialized) {
      // Concurrent first uses share one initialize() promise.
      initializing ??= source.initialize().then(() => source);
      await initializing;
    }
    repository ??= source.getRepository(JsailsBlogPost);
    return { source, repository };
  }

  /** Ensure the table exists, failing with a clear error when it is missing. */
  async function assertTableExists(): Promise<Repository<JsailsBlogPost>> {
    const { source, repository } = await ensureReady();
    const queryRunner = source.createQueryRunner();
    try {
      await queryRunner.connect();
      if (!(await queryRunner.hasTable(BLOG_POST_TABLE))) {
        throw new BlogStoreError(
          'the jsails_blog_post table does not exist; run makemigrations and migrate to create it',
        );
      }
    } finally {
      await queryRunner.release();
    }
    return repository;
  }

  async function list(): Promise<readonly BlogPost[]> {
    const repository = await assertTableExists();
    const rows = await repository.find({
      where: { published: true },
      order: { id: 'ASC' },
    });
    return rows.map(toBlogPost);
  }

  async function get(id: number): Promise<BlogPost | undefined> {
    const repository = await assertTableExists();
    const row = await repository.findOneBy({ id });
    return row === null ? undefined : toBlogPost(row);
  }

  async function create(input: BlogPostInput): Promise<BlogPost> {
    const repository = await assertTableExists();
    const timestamp = now();
    const row = await repository.save(
      repository.create({
        title: input.title,
        slug: slugify(input.title),
        body: input.body,
        published: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    return toBlogPost(row);
  }

  async function update(id: number, input: BlogPostInput): Promise<BlogPost | undefined> {
    const repository = await assertTableExists();
    const row = await repository.findOneBy({ id });
    if (row === null) {
      return undefined;
    }
    row.title = input.title;
    row.slug = slugify(input.title);
    row.body = input.body;
    row.updatedAt = now();
    return toBlogPost(await repository.save(row));
  }

  return {
    list,
    get,
    create,
    update,
    events: () => [...events],
    recordEvent(event) {
      events.push(event);
    },
  };
}
