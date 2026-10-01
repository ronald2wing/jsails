/**
 * Starter UI SSR contract tests.
 *
 * These tests render the starter components and pages through the thin Preact
 * server renderer and assert the emitted markup: escaping, accessible
 * label/help/error linkage, the controlled-dialog SSR contract, deterministic
 * counter output, the shared document shell, the island markers, and the
 * stable asset URLs. There is no DOM or test-renderer installed, so browser
 * interaction (focus, Esc, `showModal`, hydration, Turbo navigation) is NOT
 * verified here — that belongs to the browser harness.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RequestContext } from '../../src/contracts/http.js';
import { renderToString } from '../../src/jsx/render-to-string.js';
import { Dialog, Field } from '../../templates/starter/ui/components.js';
import { Counter, INITIAL_COUNT } from '../../templates/starter/ui/counter.js';
import { Layout, loadLayout } from '../../templates/starter/ui/layout.js';
import IndexPage from '../../templates/starter/pages/index.js';
import AboutPage from '../../templates/starter/pages/about.js';

/** A request context carrying only the asset resolver the layout helper reads. */
function contextWithAssetUrl(assetUrl?: RequestContext['assetUrl']): RequestContext {
  return { assetUrl } as unknown as RequestContext;
}

describe('Field', () => {
  it('links the label to the control by explicit id', () => {
    const html = renderToString(
      <Field id="email" label="Email">
        <input id="email" />
      </Field>,
    );
    assert.match(html, /<label class="label" for="email">Email<\/label>/);
    assert.match(html, /<input id="email"/);
  });

  it('emits derived help/error ids for the caller to reference', () => {
    const html = renderToString(
      <Field id="email" label="Email" help="We never share it." error="Required.">
        <input id="email" aria-invalid="true" aria-describedby="email-help email-error" />
      </Field>,
    );
    assert.match(html, /id="email-help"/);
    assert.match(html, /id="email-error"/);
    assert.match(html, /aria-describedby="email-help email-error"/);
    assert.match(html, /role="alert"/);
  });

  it('renders a label without for when no id is given', () => {
    const html = renderToString(
      <Field label="Email">
        <input />
      </Field>,
    );
    assert.match(html, /<label class="label">Email<\/label>/);
    assert.doesNotMatch(html, /for=/);
  });

  it('escapes label, help, and error content', () => {
    const html = renderToString(
      <Field id="x" label={`<b>L</b>`} help={`<i>H</i>`} error={`<u>E</u>`}>
        <input id="x" />
      </Field>,
    );
    assert.doesNotMatch(html, /<b>|<i>|<u>/);
    assert.match(html, /&lt;b>L&lt;\/b>/);
    assert.match(html, /&lt;i>H&lt;\/i>/);
    assert.match(html, /&lt;u>E&lt;\/u>/);
  });
});

describe('Dialog', () => {
  it('renders closed during SSR even when open is true (effects do not run)', () => {
    const html = renderToString(
      <Dialog open label="Confirm">
        <p>Are you sure?</p>
      </Dialog>,
    );
    assert.match(html, /^<dialog/);
    assert.doesNotMatch(html, /\bopen\b/);
    assert.match(html, /aria-label="Confirm"/);
  });

  it('renders closed during SSR when open is false', () => {
    const html = renderToString(
      <Dialog open={false} label="Confirm">
        <p>Are you sure?</p>
      </Dialog>,
    );
    assert.doesNotMatch(html, /\bopen\b/);
  });

  it('forwards an accessible name and children', () => {
    const html = renderToString(
      <Dialog open label="Delete item">
        <p>This cannot be undone.</p>
      </Dialog>,
    );
    assert.match(html, /aria-label="Delete item"/);
    assert.match(html, /This cannot be undone\./);
  });

  it('supports aria-labelledby instead of a label string', () => {
    const html = renderToString(
      <Dialog open aria-labelledby="dlg-title">
        <h3 id="dlg-title">Title</h3>
      </Dialog>,
    );
    assert.match(html, /aria-labelledby="dlg-title"/);
    assert.doesNotMatch(html, /aria-label=/);
  });
});

describe('Counter', () => {
  it('exports INITIAL_COUNT as 0', () => {
    assert.equal(INITIAL_COUNT, 0);
  });

  it('renders the initial count deterministically', () => {
    const html = renderToString(<Counter initial={INITIAL_COUNT} />);
    assert.match(html, /data-counter-value[^>]*>0</);
  });

  it('renders the same markup for the same initial value', () => {
    const first = renderToString(<Counter initial={7} />);
    const second = renderToString(<Counter initial={7} />);
    assert.equal(first, second);
  });

  it('exposes the stable interaction markers', () => {
    const html = renderToString(<Counter initial={INITIAL_COUNT} />);
    assert.match(html, /data-counter-increment/);
    assert.match(html, /data-open-dialog/);
    assert.match(html, /data-close-dialog/);
  });

  it('renders the dialog closed during SSR', () => {
    const html = renderToString(<Counter initial={INITIAL_COUNT} />);
    assert.match(html, /<dialog/);
    assert.doesNotMatch(html, /<dialog[^>]*\bopen\b/);
  });

  it('gives the dialog an accessible name via aria-labelledby', () => {
    const html = renderToString(<Counter initial={INITIAL_COUNT} />);
    assert.match(html, /aria-labelledby="counter-dialog-title"/);
    assert.match(html, /id="counter-dialog-title"/);
  });
});

describe('Layout', () => {
  it('renders a full document with the light daisyUI theme', () => {
    const html = renderToString(<Layout title="Title">body</Layout>);
    assert.match(html, /^<html lang="en" data-theme="light">/);
    assert.match(html, /<title>Title<\/title>/);
  });

  it('escapes the title text', () => {
    const html = renderToString(<Layout title={`<b>T</b>`}>body</Layout>);
    assert.doesNotMatch(html, /<title><b>/);
    assert.match(html, /<title>&lt;b>T&lt;\/b><\/title>/);
  });

  it('references the stable stylesheet and client entry URLs', () => {
    const html = renderToString(<Layout title="Title">body</Layout>);
    assert.match(html, /<link rel="stylesheet" href="\/assets\/app\.css"/);
    assert.match(html, /<script type="module" src="\/assets\/app\.js"/);
  });

  it('marks the asset tags for Turbo Drive', () => {
    const html = renderToString(<Layout title="Title">body</Layout>);
    assert.match(html, /data-turbo-track="reload"/);
    assert.match(html, /data-turbo-eval="false"/);
  });

  it('applies data-turbo-track to both asset tags', () => {
    const html = renderToString(<Layout title="Title">body</Layout>);
    assert.match(html, /<link[^>]*data-turbo-track="reload"/);
    assert.match(html, /<script[^>]*data-turbo-track="reload"/);
  });

  it('renders supplied asset URLs into the tag attributes', () => {
    const html = renderToString(
      <Layout
        title="Title"
        assets={{ appCss: '/assets/app.css?v=abc', appJs: '/assets/app.js?v=abc' }}
      >
        body
      </Layout>,
    );
    assert.match(html, /href="\/assets\/app\.css\?v=abc"/);
    assert.match(html, /src="\/assets\/app\.js\?v=abc"/);
  });

  it('escapes asset URLs rendered as attributes', () => {
    const html = renderToString(
      <Layout title="Title" assets={{ appCss: '/a.css?v=1&x="2"', appJs: '/a.js?v=1&x="2"' }}>
        body
      </Layout>,
    );
    assert.match(html, /href="\/a\.css\?v=1&amp;x=&quot;2&quot;"/);
    assert.match(html, /src="\/a\.js\?v=1&amp;x=&quot;2&quot;"/);
    assert.doesNotMatch(html, /x="2"/);
  });

  it('renders normal Home and About links', () => {
    const html = renderToString(<Layout title="Title">body</Layout>);
    assert.match(html, /<a class="btn btn-ghost" href="\/">Home<\/a>/);
    assert.match(html, /<a class="btn btn-ghost" href="\/about">About<\/a>/);
  });

  it('renders children inside the main landmark', () => {
    const html = renderToString(<Layout title="Title">body</Layout>);
    assert.match(html, /<main[^>]*>body<\/main>/);
  });
});

describe('loadLayout', () => {
  it('forwards both fixed asset paths to context.assetUrl and returns its URLs', async () => {
    const seen: string[] = [];
    const assets = await loadLayout(
      contextWithAssetUrl((path) => {
        seen.push(path);
        return `${path}?v=hash`;
      }),
    );
    assert.deepEqual(seen, ['/assets/app.css', '/assets/app.js']);
    assert.deepEqual(assets, {
      appCss: '/assets/app.css?v=hash',
      appJs: '/assets/app.js?v=hash',
    });
  });

  it('awaits an async asset resolver', async () => {
    const assets = await loadLayout(contextWithAssetUrl(async (path) => `${path}?v=async`));
    assert.deepEqual(assets, {
      appCss: '/assets/app.css?v=async',
      appJs: '/assets/app.js?v=async',
    });
  });

  it('defaults to plain paths when no resolver is wired in', async () => {
    const assets = await loadLayout(contextWithAssetUrl(undefined));
    assert.deepEqual(assets, {
      appCss: '/assets/app.css',
      appJs: '/assets/app.js',
    });
  });
});

describe('IndexPage', () => {
  it('renders a full document with the light daisyUI theme', () => {
    const html = renderToString(<IndexPage />);
    assert.match(html, /^<html lang="en" data-theme="light">/);
    assert.match(html, /<title>JSails Starter<\/title>/);
  });

  it('references the stable stylesheet and client entry URLs', () => {
    const html = renderToString(<IndexPage />);
    assert.match(html, /<link rel="stylesheet" href="\/assets\/app\.css"/);
    assert.match(html, /<script type="module" src="\/assets\/app\.js"/);
  });

  it('mounts the counter into #counter-root with INITIAL_COUNT', () => {
    const html = renderToString(<IndexPage />);
    assert.match(html, /<div id="counter-root"/);
    assert.match(html, /data-counter-value[^>]*>0</);
  });

  it('marks #counter-root as the counter island with serialized props', () => {
    const html = renderToString(<IndexPage />);
    assert.match(html, /id="counter-root"[^>]*data-jsails-island="counter"/);
    // Preact escapes the JSON quotes in the attribute value.
    assert.match(html, /data-jsails-props="\{&quot;initial&quot;:0\}"/);
  });

  it('states that the counter is local and resets on reload', () => {
    const html = renderToString(<IndexPage />);
    assert.match(html, /local to this page/i);
    assert.match(html, /resets on reload/i);
  });
});

describe('AboutPage', () => {
  it('renders a full document with its own title', () => {
    const html = renderToString(<AboutPage />);
    assert.match(html, /^<html lang="en" data-theme="light">/);
    assert.match(html, /<title>About — JSails Starter<\/title>/);
  });

  it('renders a normal back link to home', () => {
    const html = renderToString(<AboutPage />);
    assert.match(html, /<a class="btn btn-primary" href="\/">Back to home<\/a>/);
  });

  it('renders an optional hash anchor link', () => {
    const html = renderToString(<AboutPage />);
    assert.match(html, /<a class="btn btn-outline" href="\/#counter-root">/);
  });

  it('renders no island markers or client state', () => {
    const html = renderToString(<AboutPage />);
    assert.doesNotMatch(html, /data-jsails-island/);
    assert.doesNotMatch(html, /data-jsails-props/);
  });
});
