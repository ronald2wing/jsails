/**
 * Server-component download integration: an action returning `download()` maps
 * to a signed download reference in the update response, and `handleDownload`
 * streams the stored file back (subject-scoped, authority-checked).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Readable } from 'node:stream';

import { z } from 'zod';

import type { RequestContext } from '../../src/contracts/http.js';
import {
  createServerComponentsRuntime,
  type ServerComponentsRuntime,
} from '../../src/server-components/runtime.js';
import { createComponentSigner } from '../../src/server-components/snapshot.js';
import { createUploadReferenceSigner } from '../../src/server-components/uploads.js';
import { createDownloadReferenceSigner } from '../../src/server-components/downloads.js';
import { defineAction, defineServerComponent } from '../../src/server-components/component.js';
import { download } from '../../src/server-components/downloads.js';
import {
  COMPONENT_CSRF_HEADER,
  COMPONENT_CSRF_ATTRIBUTE,
  COMPONENT_SNAPSHOT_ATTRIBUTE,
} from '../../src/server-components/protocol.js';
import { h } from 'preact';

const KEY = '0123456789abcdef0123456789abcdef';
const ORIGIN = 'http://localhost';

const downloader = defineServerComponent<{ title: string }>({
  name: 'Downloader',
  stateSchema: z.object({ title: z.string() }).strict(),
  writableKeys: ['title'],
  initialState() {
    return { title: 'report' };
  },
  authorize() {
    return true;
  },
  actions: {
    go: defineAction({
      run() {
        return download('file-1', {
          filename: 'report.pdf',
          contentType: 'application/pdf',
        });
      },
    }),
    noop: defineAction({
      run() {
        // Returns undefined — no download.
      },
    }),
  },
  render(state) {
    return h('p', null, state.title);
  },
});

/** In-memory stand-in for `UploadStore`, keyed by subject + id. */
function makeMemoryStore(): {
  store: import('../../src/server-components/uploads.js').UploadStore;
  put(id: string, subject: string | null, bytes: Buffer): void;
} {
  const files = new Map<string, Buffer>();
  return {
    store: {
      async put(input) {
        const chunks: Buffer[] = [];
        for await (const chunk of input.stream) chunks.push(Buffer.from(chunk));
        files.set(`${input.subject ?? 'anon'}/${input.id}`, Buffer.concat(chunks));
        return { size: chunks.reduce((n, c) => n + c.length, 0) };
      },
      async open(id, subject) {
        const buf = files.get(`${subject ?? 'anon'}/${id}`);
        return buf === undefined ? null : Readable.from([buf]);
      },
      async delete(id, subject) {
        files.delete(`${subject ?? 'anon'}/${id}`);
      },
    },
    put(id, subject, bytes) {
      files.set(`${subject ?? 'anon'}/${id}`, bytes);
    },
  };
}

function makeRuntime(memory: ReturnType<typeof makeMemoryStore>): ServerComponentsRuntime {
  return createServerComponentsRuntime({
    components: { Downloader: downloader },
    signer: createComponentSigner({ key: KEY, now: () => 0 }),
    uploads: {
      store: memory.store,
      signer: createUploadReferenceSigner({ key: KEY, now: () => 0 }),
      downloadSigner: createDownloadReferenceSigner({ key: KEY, now: () => 0 }),
    },
  });
}

function makeRequest(url: string, headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request(url, { method, headers });
}

function renderContext(): RequestContext {
  const url = new URL(`${ORIGIN}/downloader`);
  return { request: makeRequest(url.toString()), url, params: {}, session: null };
}

function updateContext(csrf: string): RequestContext {
  const url = new URL(`${ORIGIN}/downloader`);
  return {
    request: makeRequest(url.toString(), { origin: ORIGIN, [COMPONENT_CSRF_HEADER]: csrf }, 'POST'),
    url,
    params: {},
    session: null,
  };
}

/** Resolve the runtime's relative download path to an absolute URL. */
function downloadRequestUrl(url: string): string {
  return new URL(url, ORIGIN).toString();
}

/** Build a request context whose URL is the absolute download URL. */
function downloadContext(url: string): RequestContext {
  const absolute = downloadRequestUrl(url);
  return { request: makeRequest(absolute), url: new URL(absolute), params: {}, session: null };
}

function extractAttr(html: string, name: string): string {
  const match = html.match(new RegExp(`${name}="([^"]*)"`));
  assert.ok(match, `expected attribute ${name}`);
  return match[1]!;
}

describe('server-component downloads', () => {
  it('maps a download() action to a signed download reference in the update response', async () => {
    const memory = makeMemoryStore();
    memory.put('file-1', null, Buffer.from('pdf-bytes'));
    const runtime = makeRuntime(memory);

    const html = await runtime.render('Downloader', renderContext());
    const snapshot = extractAttr(html, COMPONENT_SNAPSHOT_ATTRIBUTE);
    const csrf = extractAttr(html, COMPONENT_CSRF_ATTRIBUTE);

    const result = await runtime.update(
      { snapshot, updates: { title: 'changed' }, sequence: 1, action: { name: 'go' } },
      updateContext(csrf),
    );

    assert.equal(result.status, 200);
    const downloadRef = (result.body as { download?: { url: string; filename: string } }).download;
    assert.ok(downloadRef, 'download must be present in the response body');
    assert.equal(downloadRef.filename, 'report.pdf');
    assert.match(downloadRef.url, /\/_jsails\/components\/download\?ref=/);
  });

  it('omits download when the action returns undefined', async () => {
    const memory = makeMemoryStore();
    const runtime = makeRuntime(memory);

    const html = await runtime.render('Downloader', renderContext());
    const snapshot = extractAttr(html, COMPONENT_SNAPSHOT_ATTRIBUTE);
    const csrf = extractAttr(html, COMPONENT_CSRF_ATTRIBUTE);

    const result = await runtime.update(
      { snapshot, updates: {}, sequence: 1, action: { name: 'noop' } },
      updateContext(csrf),
    );

    assert.equal(result.status, 200);
    assert.ok(!('download' in result.body), 'body must not carry a download key');
  });

  it('handleDownload streams the file with attachment headers for a valid reference', async () => {
    const memory = makeMemoryStore();
    memory.put('file-1', null, Buffer.from('pdf-bytes'));
    const runtime = makeRuntime(memory);

    const html = await runtime.render('Downloader', renderContext());
    const snapshot = extractAttr(html, COMPONENT_SNAPSHOT_ATTRIBUTE);
    const csrf = extractAttr(html, COMPONENT_CSRF_ATTRIBUTE);
    const result = await runtime.update(
      { snapshot, updates: {}, sequence: 1, action: { name: 'go' } },
      updateContext(csrf),
    );
    const url = (result.body as { download: { url: string } }).download.url;

    const handleResult = await runtime.handleDownload(
      makeRequest(downloadRequestUrl(url)),
      downloadContext(url),
    );

    assert.equal(handleResult.status, 200);
    assert.equal(handleResult.contentType, 'application/pdf');
    assert.equal(handleResult.filename, 'report.pdf');
    const chunks: Buffer[] = [];
    for await (const chunk of handleResult.stream!) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'pdf-bytes');
  });

  it('handleDownload rejects a tampered reference', async () => {
    const memory = makeMemoryStore();
    const runtime = makeRuntime(memory);

    const html = await runtime.render('Downloader', renderContext());
    const snapshot = extractAttr(html, COMPONENT_SNAPSHOT_ATTRIBUTE);
    const csrf = extractAttr(html, COMPONENT_CSRF_ATTRIBUTE);
    const result = await runtime.update(
      { snapshot, updates: {}, sequence: 1, action: { name: 'go' } },
      updateContext(csrf),
    );
    const url = (result.body as { download: { url: string } }).download.url;
    const tampered = url.replace(/ref=[^&]+/, 'ref=tampered');

    const handleResult = await runtime.handleDownload(
      makeRequest(downloadRequestUrl(tampered)),
      downloadContext(tampered),
    );

    assert.equal(handleResult.status, 403);
  });

  it('handleDownload returns 404 for an unknown file id', async () => {
    const memory = makeMemoryStore();
    memory.put('other', null, Buffer.from('x'));
    const runtime = makeRuntime(memory);

    const html = await runtime.render('Downloader', renderContext());
    const snapshot = extractAttr(html, COMPONENT_SNAPSHOT_ATTRIBUTE);
    const csrf = extractAttr(html, COMPONENT_CSRF_ATTRIBUTE);
    const result = await runtime.update(
      { snapshot, updates: {}, sequence: 1, action: { name: 'go' } },
      updateContext(csrf),
    );
    const url = (result.body as { download: { url: string } }).download.url;

    const handleResult = await runtime.handleDownload(
      makeRequest(downloadRequestUrl(url)),
      downloadContext(url),
    );

    assert.equal(handleResult.status, 404);
  });
});
