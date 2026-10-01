/**
 * Feature-flags admin page tests.
 *
 * These drive the flags admin page through a real in-process `Application`: the
 * admin plugin is mounted as an extension, the flags page is passed as a panel
 * page, and every request is routed through the same pipeline `serve` uses. No
 * browser, database, Valkey, or listener is involved.
 *
 * The `defineFlagsAdminPage` factory accepts `flags?: FeatureFlags` directly, so
 * tests inject a store-backed `FeatureFlagService` seeded with known flags.
 *
 * Coverage:
 * - Unavailable: the page renders "not enabled" when `flags` is undefined.
 * - Empty listing: no global flags → "No global flags configured."
 * - Flag listing: active/inactive badges and toggle buttons in the table.
 * - Toggle: POST to activate an inactive flag, POST to deactivate an active flag.
 * - Invalid POST: missing key/active fields → 400; unknown flag → 404.
 * - Auth gate: the default-deny auth still applies (403 when unauthorized).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defineAdminPanel, adminPlugin } from '../../src/admin/index.js';
import type { Session } from '../../src/contracts/http.js';
import { FeatureFlagService, MemoryFeatureStore } from '../../src/flags/flags.js';
import { defineFlagsAdminPage } from '../../src/flags/admin-page.js';
import { createTestApp, type TestApplication } from '../../src/testing/app.js';

const SESSION: Session = {
  id: 'admin-session-1',
  csrfToken: 'csrf-secret-token',
  data: { userId: 'u1' },
  expiresAt: 2_000_000_000_000,
};

/** POST an application/x-www-form-urlencoded body with a same-origin header. */
function postForm(
  app: TestApplication,
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: {
      origin: app.origin,
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

// ---------------------------------------------------------------------------
// Helper: build a test app with the flags admin page wired directly
// ---------------------------------------------------------------------------

async function makeApp(
  flagsSeeds: Record<string, boolean> | undefined,
  authorize?: (session: Session | null) => boolean | Promise<boolean>,
): Promise<TestApplication> {
  const store = new MemoryFeatureStore();
  if (flagsSeeds !== undefined) {
    for (const [key, value] of Object.entries(flagsSeeds)) {
      await store.set(key, value);
    }
  }

  // When flagsSeeds is undefined, pass flags: undefined (unavailable page).
  // When flagsSeeds is defined, inject the FeatureFlagService directly.
  const featureFlags = flagsSeeds !== undefined ? new FeatureFlagService(store) : undefined;

  return createTestApp({
    config: {
      port: 0,
      extensions: [
        adminPlugin(
          defineAdminPanel({
            resolveSession: () => SESSION,
            authorize: authorize ?? (() => true),
            pages: [defineFlagsAdminPage({ flags: featureFlags })],
          }),
        ),
      ],
    },
  });
}

describe('flags admin page unavailable', { concurrency: 1 }, () => {
  it('renders unavailable message when flags service is absent', async () => {
    const app = await makeApp(undefined);
    const response = await app.request('/admin/flags');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /not enabled/);
    assert.match(html, /Feature Flags/);
    await app.close();
  });
});

describe('flags admin page empty', { concurrency: 1 }, () => {
  it('renders no-flags message when the store is empty', async () => {
    const app = await makeApp({});
    const response = await app.request('/admin/flags');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /No global flags configured/);
    assert.match(html, /Feature Flags/);
    await app.close();
  });
});

describe('flags admin page listing', { concurrency: 1 }, () => {
  it('lists flags with active/inactive badges and toggle buttons', async () => {
    const app = await makeApp({
      'new-checkout': true,
      'dark-mode': false,
      'beta-feature': true,
    });
    const response = await app.request('/admin/flags');
    assert.equal(response.status, 200);
    const html = await response.text();

    // All three flags appear as code elements.
    assert.match(html, /<code>beta-feature<\/code>/);
    assert.match(html, /<code>dark-mode<\/code>/);
    assert.match(html, /<code>new-checkout<\/code>/);

    // Active flags show the "active" badge and a Deactivate button.
    // Use more specific patterns to avoid matching "active" in the CSS.
    assert.match(
      html,
      /<code>new-checkout<\/code>[\s\S]*?<span class="admin-badge">active<\/span>[\s\S]*?>Deactivate</,
    );
    assert.match(
      html,
      /<code>beta-feature<\/code>[\s\S]*?<span class="admin-badge">active<\/span>[\s\S]*?>Deactivate</,
    );

    // The inactive flag shows the "inactive" badge and an Activate button.
    assert.match(
      html,
      /<code>dark-mode<\/code>[\s\S]*?<span class="admin-badge admin-badge-inactive">inactive<\/span>[\s\S]*?>Activate</,
    );

    // The scope note is rendered.
    assert.match(html, /global only/);

    // The back link is rendered.
    assert.match(html, /Back to dashboard/);

    await app.close();
  });
});

describe('flags admin page toggle', { concurrency: 1 }, () => {
  it('activates an inactive flag via POST', async () => {
    const app = await makeApp({ experiment: false });
    const response = await postForm(app, '/admin/flags', {
      _csrf: SESSION.csrfToken,
      flag_key: 'experiment',
      flag_active: 'true',
    });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location') ?? '', /notice=flag_activated/);

    // Verify the flag was actually toggled. The notice is a redirect-time query
    // (read from the 303 Location), not persisted state — a fresh GET shows the
    // toggled state, not the notice.
    const getResp = await app.request('/admin/flags');
    const html = await getResp.text();
    assert.match(html, /<span class="admin-badge">active<\/span>/);
    await app.close();
  });

  it('deactivates an active flag via POST', async () => {
    const app = await makeApp({ experiment: true });
    const response = await postForm(app, '/admin/flags', {
      _csrf: SESSION.csrfToken,
      flag_key: 'experiment',
      flag_active: 'false',
    });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location') ?? '', /notice=flag_deactivated/);

    const getResp = await app.request('/admin/flags');
    const html = await getResp.text();
    assert.match(html, /<span class="admin-badge admin-badge-inactive">inactive<\/span>/);
    await app.close();
  });

  it('returns 400 when flag_key is missing', async () => {
    const app = await makeApp({ experiment: true });
    const response = await postForm(app, '/admin/flags', {
      _csrf: SESSION.csrfToken,
      flag_active: 'false',
    });
    assert.equal(response.status, 400);
    await app.close();
  });

  it('returns 400 when flag_active is missing', async () => {
    const app = await makeApp({ experiment: true });
    const response = await postForm(app, '/admin/flags', {
      _csrf: SESSION.csrfToken,
      flag_key: 'experiment',
    });
    assert.equal(response.status, 400);
    await app.close();
  });

  it('returns 400 for an invalid flag_active value', async () => {
    const app = await makeApp({ experiment: true });
    const response = await postForm(app, '/admin/flags', {
      _csrf: SESSION.csrfToken,
      flag_key: 'experiment',
      flag_active: 'invalid',
    });
    assert.equal(response.status, 400);
    await app.close();
  });

  it('returns 404 when the flag key is unknown', async () => {
    const app = await makeApp({ experiment: true });
    const response = await postForm(app, '/admin/flags', {
      _csrf: SESSION.csrfToken,
      flag_key: 'nonexistent',
      flag_active: 'true',
    });
    assert.equal(response.status, 404);
    await app.close();
  });
});

describe('flags admin page auth gate', { concurrency: 1 }, () => {
  it('returns 403 when the admin authorize rejects', async () => {
    const app = await makeApp({ experiment: true }, () => false);
    const response = await app.request('/admin/flags');
    assert.equal(response.status, 403);
    await app.close();
  });
});
