/**
 * Blog admin: the admin-panel CRUD surface for the blog posts.
 *
 * `blogAdmin(options?)` returns an {@link AdminPlugin} (id `blog`) whose
 * `register` contributes a single resource (slug `posts`, label `Posts`) backed
 * by a {@link BlogPostStore}. The resource mounts the standard list/new/create/
 * edit/update routes under the admin panel path, so the blog is editable from
 * the admin dashboard exactly like any other resource.
 *
 * The store is captured by closure, so an application that also mounts
 * {@link blogPlugin} must build one store — {@link createBlogStore} or
 * {@link createDatabaseBlogStore} — and hand the same instance to both,
 * otherwise the HTTP list/create surface and the admin CRUD surface would write
 * to two different stores.
 *
 * The module is ORM-free: it imports only the admin resource/plugin descriptors
 * and the blog plugin's store types.
 */

import { defineAdminPlugin, type AdminPlugin } from '../admin/admin-plugin.js';
import { defineResource } from '../admin/resource.js';
import { createBlogStore, type BlogPostInput, type BlogPostStore } from './plugin.js';

/** Options for {@link blogAdmin}. */
export interface BlogAdminOptions {
  /** The post store to back the resource; defaults to a fresh in-memory store. */
  store?: BlogPostStore;
}

/** Coerce resource-form values into a post input (non-strings become empty). */
function toInput(values: Record<string, unknown>): BlogPostInput {
  return {
    title: typeof values['title'] === 'string' ? values['title'] : '',
    body: typeof values['body'] === 'string' ? values['body'] : '',
  };
}

/** Parse a resource record id into a safe integer, or `null` when invalid. */
function toId(id: string): number | null {
  const value = Number(id);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Build the blog admin plugin. Every call creates its own store unless one is
 * injected, so the descriptor owns no global state. The returned descriptor is
 * inert until {@link adminPlugin} invokes its `register` during assembly.
 */
export function blogAdmin(options: BlogAdminOptions = {}): AdminPlugin {
  const store = options.store ?? createBlogStore();
  return defineAdminPlugin({
    id: 'blog',
    register(builder) {
      builder.addResource(
        defineResource({
          slug: 'posts',
          label: 'Posts',
          columns: [
            { name: 'id', label: 'ID' },
            { name: 'title', label: 'Title' },
          ],
          fields: [
            { name: 'title', label: 'Title', type: 'text' },
            { name: 'body', label: 'Body', type: 'textarea' },
          ],
          list: async ({ page, pageSize }) => {
            const posts = await store.list();
            const start = (page - 1) * pageSize;
            return {
              rows: posts.slice(start, start + pageSize).map((post) => ({
                id: post.id,
                title: post.title,
              })),
              total: posts.length,
            };
          },
          get: async ({ id }) => {
            const numeric = toId(id);
            if (numeric === null) {
              return null;
            }
            const post = await store.get(numeric);
            if (post === undefined) {
              return null;
            }
            return { title: post.title, body: post.body };
          },
          save: async ({ id, values }) => {
            const input = toInput(values);
            if (id === null) {
              const post = await store.create(input);
              post.createdAt = new Date().toISOString();
              return;
            }
            const numeric = toId(id);
            if (numeric === null) {
              return;
            }
            await store.update(numeric, input);
          },
        }),
      );
    },
  });
}
