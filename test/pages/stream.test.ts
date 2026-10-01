/**
 * Page streaming tests: `renderStreamResponse` and the stream life cycle.
 *
 * Fixtures are real compiled ESM files written to a temp directory and imported
 * through Node's normal module loader. Their only import is an absolute file URL
 * to the repository's built JSX runtime, so nothing here opens a service
 * connection or depends on a bundler. Because imports are process-global and
 * cached, every fixture uses a unique filename.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import type { RequestContext } from '../../src/contracts/http.js';
import { renderRoute, renderStreamResponse } from '../../src/pages/page.js';
import type { PageStream } from '../../src/contracts/render.js';
import type { RouteManifestEntry } from '../../src/routing/routes.js';

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'stream-'));
const runtimeUrl = new URL('../../src/jsx/jsx-runtime.js', import.meta.url).href;

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

let sequence = 0;
function writeModule(source: string, extension = '.js'): string {
  const file = join(tmpRoot, `fixture-stream-${sequence++}${extension}`);
  writeFileSync(file, source);
  return file;
}

function pageEntry(file: string, route = '/'): RouteManifestEntry {
  return { kind: 'page', route, file, dynamic: false, catchAll: false, params: [] };
}

function makeContext(
  params: Record<string, string> = {},
  urlString = 'http://localhost/test',
): RequestContext {
  const url = new URL(urlString);
  return { request: new Request(url), url, params, session: null };
}

const DOCTYPE = '<!DOCTYPE html>';
const SHELL_OPEN = '<html><head><meta charset="utf-8"></head><body>';
const SHELL_CLOSE = '</body></html>';

describe('renderStreamResponse', () => {
  it('wraps an AsyncIterable<string> into a streaming Response, consuming all chunks', async () => {
    async function* stream(): AsyncIterable<string> {
      yield '<h1>';
      yield 'hi';
      yield '</h1>';
    }

    const response = renderStreamResponse(stream());

    assert.equal(response.status, 200);
    const contentType = response.headers.get('content-type') ?? '';
    assert.ok(contentType.includes('text/html'), `expected text/html, got: ${contentType}`);
    assert.equal(response.headers.get('x-accel-buffering'), 'no');

    const body = await response.text();
    assert.equal(body, '<h1>hi</h1>');
  });

  it('wraps a ReadableStream<Uint8Array> into a streaming Response', async () => {
    const encoder = new TextEncoder();
    const webStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('<h1>'));
        controller.enqueue(encoder.encode('stream'));
        controller.enqueue(encoder.encode('</h1>'));
        controller.close();
      },
    });

    const response = renderStreamResponse(webStream);

    assert.equal(response.status, 200);
    const contentType = response.headers.get('content-type') ?? '';
    assert.ok(contentType.includes('text/html'), `expected text/html, got: ${contentType}`);
    assert.equal(response.headers.get('x-accel-buffering'), 'no');

    const body = await response.text();
    assert.equal(body, '<h1>stream</h1>');
  });

  it('wraps a Node Readable into a streaming Response', async () => {
    const nodeStream = Readable.from(['<h1>', 'node', '</h1>']);

    const response = renderStreamResponse(nodeStream as PageStream);

    assert.equal(response.status, 200);
    const contentType = response.headers.get('content-type') ?? '';
    assert.ok(contentType.includes('text/html'), `expected text/html, got: ${contentType}`);

    const body = await response.text();
    assert.equal(body, '<h1>node</h1>');
  });

  it('respects caller-supplied Content-Type header', async () => {
    async function* stream(): AsyncIterable<string> {
      yield 'ok';
    }

    const response = renderStreamResponse(stream(), {
      'content-type': 'application/xml; charset=utf-8',
    });

    assert.equal(response.headers.get('content-type'), 'application/xml; charset=utf-8');
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
  });

  it('does not override x-accel-buffering when caller supplies a different header', async () => {
    async function* stream(): AsyncIterable<string> {
      yield 'ok';
    }

    // renderStreamResponse sets x-accel-buffering unconditionally, so caller
    // headers that mention it would appear twice; the last set wins.
    const response = renderStreamResponse(stream(), {
      'x-accel-buffering': 'yes',
    });
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
  });
});

describe('renderRoute', () => {
  it('does not invoke stream: default + load path stays unchanged', async () => {
    // A module with both default and load but NO stream still renders via the
    // string path. renderRoute only uses default/load — stream is the route
    // handler's concern, not the renderer's.
    const file = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export function load() { return { msg: 'hello' }; }
       export default function Page({ msg }) {
         return jsx('p', { children: msg });
       }
      `,
    );

    const html = await renderRoute(pageEntry(file), makeContext());
    assert.equal(html, `${DOCTYPE}${SHELL_OPEN}<p>hello</p>${SHELL_CLOSE}`);
  });

  it('renders a streaming-module fixture through default+load in static path', async () => {
    // Even when the module has a stream export, renderRoute (the static path)
    // only uses default and load — never stream.
    const file = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export async function* stream(context) { yield '<h1>static-ignores-this</h1>'; }
       export function load() { return { msg: 'rendered' }; }
       export default function Page({ msg }) {
         return jsx('p', { children: msg });
       }
      `,
    );

    const html = await renderRoute(pageEntry(file), makeContext());
    assert.equal(html, `${DOCTYPE}${SHELL_OPEN}<p>rendered</p>${SHELL_CLOSE}`);
  });
});
