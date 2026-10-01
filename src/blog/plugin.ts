/**
 * First-party blog plugin: a minimal blog over a pluggable post store.
 *
 * This plugin demonstrates the `definePlugin` contract end to end. The store is
 * injectable: the default is a plain in-memory array, and
 * `createDatabaseBlogStore` (see `./database-store.js`) backs the same interface with
 * MariaDB/Postgres/SQLite via TypeORM. One `blogPlugin` call contributes:
 *
 * - a typed `blogPosts` service (an in-memory post store with list/create/
 *   get/update);
 * - a `blog.post.create` operation, guarded by a before interceptor (trim and
 *   reject an empty title with a value-free error) and an after interceptor
 *   (stamp `createdAt`);
 * - a `blog.post.created` event whose observer records the event in the store,
 *   with observer errors isolated per the observer contract;
 * - two Hono routes: `GET /blog` (escaped list, with an empty-state message)
 *   and `POST /blog/posts` (form `title`/`body`; 303 redirect on success, 422
 *   with a value-free error on validation failure).
 *
 * The operation/event tokens are module-level so consumers (other plugins and
 * tests) can import the same identities the plugin registers against.
 * `createBlogStore` is exported so an application can build one store and hand
 * the same instance to both `blogPlugin` and `blogAdmin`, keeping
 * the HTTP list/create surface and the admin CRUD surface backed by one store.
 */

import { escapeHtml } from '../internal/html.js';
import {
  createServiceToken,
  defineEvent,
  defineOperation,
  definePlugin,
  type AfterInterceptor,
  type BeforeInterceptor,
  type JsailsPlugin,
  type Observer,
} from '../extensions/index.js';

/** A blog post. `createdAt` is stamped by the after interceptor (or the store). */
export interface BlogPost {
  readonly id: number;
  readonly title: string;
  readonly body: string;
  createdAt: string;
}

/** Raw input handed to the `blog.post.create` operation (and `update`). */
export interface BlogPostInput {
  title: string;
  body: string;
}

/** Payload of the `blog.post.created` event. */
export interface BlogPostCreatedEvent {
  readonly post: BlogPost;
}

/**
 * The blog's post store. Injectable so tests can assert on identity and control
 * the sequence; the default implementation is a plain in-memory array. It backs
 * both the plugin's HTTP routes and the admin resource. Reads and writes are
 * async because the database-backed store resolves them from TypeORM.
 */
export interface BlogPostStore {
  /** All posts in insertion order (a copy, so callers cannot mutate the store). */
  list(): Promise<readonly BlogPost[]>;
  /** The post with the given id, or `undefined` when absent. */
  get(id: number): Promise<BlogPost | undefined>;
  /** Insert a post, assigning the next id. Returns the inserted (mutable) post. */
  create(input: BlogPostInput): Promise<BlogPost>;
  /** Replace the title/body of the post with the given id; `undefined` when absent. */
  update(id: number, input: BlogPostInput): Promise<BlogPost | undefined>;
  /** Events recorded by the `blog.post.created` observer, oldest first. */
  events(): readonly BlogPostCreatedEvent[];
  /** Record a created-post event (called by the observer). */
  recordEvent(event: BlogPostCreatedEvent): void;
}

/** Options for {@link blogPlugin}. */
export interface BlogPluginOptions {
  /** Override the post store; defaults to a fresh in-memory store. */
  store?: BlogPostStore;
}

/**
 * Typed service token for the post store. Shared identity: a provider and any
 * consumer must import this same token.
 */
export const blogPostsToken = createServiceToken<BlogPostStore>('blogPosts');

/** Operation token for creating a post, wrapped by the before/after interceptors. */
export const createPostOperation = defineOperation<BlogPostInput, BlogPost>('blog.post.create');

/** Event token emitted after a post is created. */
export const postCreatedEvent = defineEvent<BlogPostCreatedEvent>('blog.post.created');

/**
 * Raised when the before interceptor rejects a post. The message is fixed and
 * carries no user input, so it is safe to surface verbatim.
 */
export class BlogValidationError extends Error {
  constructor() {
    super('blog post title must be a non-empty string');
    this.name = 'BlogValidationError';
  }
}

/** Internal mutable post shape; the public `BlogPost` exposes `title`/`body` read-only. */
interface PostRecord {
  id: number;
  title: string;
  body: string;
  createdAt: string;
}

/**
 * The default in-memory post store: an array plus a monotonically increasing
 * id. Shared by the plugin routes and the admin resource via {@link blogPostsToken}.
 */
export function createBlogStore(): BlogPostStore {
  const posts: PostRecord[] = [];
  const events: BlogPostCreatedEvent[] = [];
  let nextId = 1;
  return {
    async list() {
      return [...posts];
    },
    async get(id) {
      return posts.find((post) => post.id === id);
    },
    async create(input) {
      const post: PostRecord = {
        id: nextId,
        title: input.title,
        body: input.body,
        createdAt: '',
      };
      nextId += 1;
      posts.push(post);
      return post;
    },
    async update(id, input) {
      const post = posts.find((candidate) => candidate.id === id);
      if (post === undefined) {
        return undefined;
      }
      post.title = input.title;
      post.body = input.body;
      return post;
    },
    events: () => [...events],
    recordEvent(event) {
      events.push(event);
    },
  };
}

/**
 * Build the blog plugin. Every call creates its own store unless one is
 * injected, so a plugin instance owns no global state and nothing outside the
 * application registry needs cleanup.
 */
export function blogPlugin(options: BlogPluginOptions = {}): JsailsPlugin {
  const store = options.store ?? createBlogStore();

  const beforeCreate: BeforeInterceptor<BlogPostInput> = (args) => {
    args.title = args.title.trim();
    if (args.title === '') {
      throw new BlogValidationError();
    }
  };

  const afterCreate: AfterInterceptor<BlogPostInput, BlogPost> = (result) => {
    result.createdAt = new Date().toISOString();
    return result;
  };

  const onPostCreated: Observer<BlogPostCreatedEvent> = (payload) => {
    store.recordEvent(payload);
  };

  return definePlugin({
    name: 'blog',
    setup({ services, configureHttp, intercept, observe, interceptorRegistry }) {
      services.provide(blogPostsToken, store);

      // Participate in the application's interceptor/observer graph so other
      // plugins (and tests) can hook the operation and event.
      intercept(createPostOperation, beforeCreate);
      intercept(createPostOperation, afterCreate, { phase: 'after' });
      observe(postCreatedEvent, onPostCreated);

      // Run the operation through the SHARED registry, not a private one: the
      // registry's run methods (`runBefore`/`runAfter`/`emit`) stay callable
      // after setup seals registration, so other plugins' interceptors and
      // observers on this operation/event fire for blog post creation too.
      configureHttp((app) => {
        app.get('/blog', async (c) => {
          const posts = await store.list();
          if (posts.length === 0) {
            return c.html('<p>No posts yet.</p>');
          }
          const items = posts.map((post) => `<li>${escapeHtml(post.title)}</li>`).join('');
          return c.html(`<ul>${items}</ul>`);
        });

        app.post('/blog/posts', async (c) => {
          const form = await c.req.parseBody();
          const args: BlogPostInput = {
            title: typeof form.title === 'string' ? form.title : '',
            body: typeof form.body === 'string' ? form.body : '',
          };
          try {
            await interceptorRegistry.runBefore(createPostOperation, args);
            const post = await store.create(args);
            const created = await interceptorRegistry.runAfter(createPostOperation, args, post);
            await interceptorRegistry.emit(postCreatedEvent, { post: created });
            return c.redirect('/blog', 303);
          } catch (error) {
            if (error instanceof BlogValidationError) {
              return c.html('<p>Title is required.</p>', 422);
            }
            throw error;
          }
        });
      });
    },
  });
}
