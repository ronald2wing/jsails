/**
 * Admin extension-point tests: `defineAdminPage` / `defineAdminPlugin`
 * descriptor validation plus plugin-contributed pages, resources, and
 * navigation mounted through the real admin plugin.
 *
 * These prove the Filament-style contribution seam without a browser, database,
 * Valkey, or listener: a plugin's `register` receives a builder, its
 * contributions are mounted under the panel path exactly like panel-declared
 * pages/resources, and a page/resource slug collision is rejected at assembly
 * time with a value-free `AdminPanelError`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AdminPageError,
  AdminPluginError,
  adminPlugin,
  defineAdminPage,
  defineAdminPanel,
  defineAdminPlugin,
  defineResource,
  type AdminPlugin,
  type Resource,
} from '../../src/admin/index.js';
import type { Session } from '../../src/contracts/http.js';
import { createTestApp } from '../../src/testing/app.js';

const SESSION: Session = {
  id: 'admin-session-1',
  csrfToken: 'csrf-secret-token',
  data: { userId: 'u1' },
  expiresAt: 2_000_000_000_000,
};

const notesResource: Resource = defineResource({
  slug: 'notes',
  label: 'Notes',
  columns: [{ name: 'id', label: 'ID' }],
  fields: [{ name: 'id', label: 'ID', type: 'text' }],
  list: async () => ({ rows: [{ id: '1' }], total: 1 }),
});

const reportsPage = defineAdminPage({
  slug: 'reports',
  label: 'Reports',
  render: () => '<h1>Reports</h1>',
});

const extras = defineAdminPlugin({
  id: 'extras',
  register(builder) {
    builder.addPage(reportsPage);
    builder.addNavigationItem({ label: 'Docs', href: 'https://example.com/docs', group: 'Help' });
    builder.addResource(notesResource);
  },
});

function makeApp(options: { adminPlugins?: readonly AdminPlugin[] } = {}) {
  return createTestApp({
    config: {
      port: 0,
      extensions: [
        adminPlugin(
          defineAdminPanel({
            resolveSession: () => SESSION,
            authorize: () => true,
            ...(options.adminPlugins === undefined ? {} : { adminPlugins: options.adminPlugins }),
          }),
        ),
      ],
    },
  });
}

describe('defineAdminPage validation', () => {
  it('rejects an invalid slug', () => {
    for (const slug of ['', 'a/b', 'a b', '.hidden', '-lead', 'trail-']) {
      assert.throws(
        () => defineAdminPage({ slug, label: 'X', render: () => 'x' }),
        AdminPageError,
        `slug ${JSON.stringify(slug)} must be rejected`,
      );
    }
  });

  it('rejects a missing or empty label', () => {
    assert.throws(
      () => defineAdminPage({ slug: 'x', label: '', render: () => 'x' }),
      AdminPageError,
    );
  });

  it('rejects a missing render function', () => {
    assert.throws(() => defineAdminPage({ slug: 'x', label: 'X' } as never), AdminPageError);
  });

  it('returns a frozen descriptor', () => {
    const page = defineAdminPage({ slug: 'x', label: 'X', render: () => 'x' });
    assert.equal(Object.isFrozen(page), true);
    assert.equal(page.slug, 'x');
  });
});

describe('defineAdminPlugin validation', () => {
  it('rejects a missing id', () => {
    assert.throws(() => defineAdminPlugin({ register: () => {} } as never), AdminPluginError);
  });

  it('rejects a missing register function', () => {
    assert.throws(() => defineAdminPlugin({ id: 'x' } as never), AdminPluginError);
  });

  it('returns a frozen descriptor', () => {
    const plugin = defineAdminPlugin({ id: 'x', register: () => {} });
    assert.equal(Object.isFrozen(plugin), true);
    assert.equal(plugin.id, 'x');
  });
});

describe('admin plugin contributions', () => {
  it('mounts a contributed page, resource, and navigation item', async () => {
    const app = await makeApp({ adminPlugins: [extras] });

    const reports = await app.request('/admin/reports');
    assert.equal(reports.status, 200);
    assert.match(await reports.text(), /Reports/);

    const notes = await app.request('/admin/notes');
    assert.equal(notes.status, 200);
    assert.match(await notes.text(), /Notes/);

    const dashboard = await app.request('/admin');
    const body = await dashboard.text();
    assert.match(body, /Reports/);
    assert.match(body, /Notes/);
    assert.match(body, /Docs/);
    assert.match(body, /<h2>Help<\/h2>/);

    await app.close();
  });

  it('rejects a page/resource slug collision at assembly time', async () => {
    const colliding = defineAdminPlugin({
      id: 'colliding',
      register(builder) {
        builder.addPage(defineAdminPage({ slug: 'shared', label: 'Shared', render: () => 'x' }));
        builder.addResource(
          defineResource({
            slug: 'shared',
            label: 'Shared',
            columns: [{ name: 'id', label: 'ID' }],
            fields: [{ name: 'id', label: 'ID', type: 'text' }],
            list: async () => ({ rows: [], total: 0 }),
          }),
        );
      },
    });

    await assert.rejects(makeApp({ adminPlugins: [colliding] }), /unique/);
  });
});
