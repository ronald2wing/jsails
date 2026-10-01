/**
 * The first-party blog subpath (`jsails/blog`).
 *
 * A minimal blog built on the extension system and the admin panel.
 * `blogPlugin(options?)` contributes a post store service plus the HTTP
 * list/create surface; `blogAdmin(options?)` contributes the admin CRUD
 * surface for the same store. Build one store with {@link createBlogStore}
 * (in-memory) or {@link createDatabaseBlogStore} (MariaDB/Postgres/SQLite via
 * TypeORM) and share it across both so the two surfaces stay in sync.
 */

export {
  BlogValidationError,
  blogPostsToken,
  blogPlugin,
  createBlogStore,
  createPostOperation,
  postCreatedEvent,
  type BlogPost,
  type BlogPostCreatedEvent,
  type BlogPostInput,
  type BlogPostStore,
  type BlogPluginOptions,
} from './plugin.js';

export { blogAdmin, type BlogAdminOptions } from './admin-resource.js';

// The `blog` factory is the subpath's default export, matching every other
// first-party plugin subpath: `plugins.use` resolves `'jsails/blog'` by
// importing the default export and calling it with the options tuple.
export { blogPlugin as default } from './plugin.js';

export {
  BLOG_POST_SLUG_LENGTH,
  BLOG_POST_TABLE,
  BLOG_POST_TITLE_LENGTH,
  BlogStoreError,
  JsailsBlogPost,
  blogPostEntities,
  createDatabaseBlogStore,
  type DatabaseBlogStoreOptions,
} from './database-store.js';
