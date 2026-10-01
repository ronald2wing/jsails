/**
 * Server-side upload tests for stateful server components.
 *
 * Covers the storage-and-reference half of the file-upload story end to end,
 * without a browser, HTTP listener, database, or Valkey:
 *
 * - the disk store (atomic write, streaming byte cap, subject scoping,
 *   content-type allowlist, delete/open of missing files);
 * - the signed reference signer (round-trip, tamper, expiry, claim validation,
 *   domain separation from the snapshot signer);
 * - `uploadRefSchema` and `readUploadBody`;
 * - the runtime `handleUpload` pipeline (happy path, `resolveUpload` read-back,
 *   and every security seam: origin, snapshot, CSRF, authorization, content
 *   type, oversize, missing file, disabled uploads);
 * - the HTTP mount (`/_jsails/components/upload`) including the body-limit
 *   exemption that lets an upload larger than the JSON/API cap through.
 *
 * Every fixture uses a real temp directory and injected signers with a frozen
 * clock, so nothing touches a shared path or the real filesystem.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import { z } from 'zod';

import type { RequestContext, Session } from '../../src/contracts/http.js';
import {
  defineServerComponent,
  type ServerComponentDefinition,
} from '../../src/server-components/component.js';
import { serverComponentsPlugin } from '../../src/server-components/extension.js';
import {
  COMPONENT_CSRF_HEADER,
  COMPONENT_UPLOAD_ENDPOINT,
  COMPONENT_UPLOAD_FILE_FIELD,
  COMPONENT_UPLOAD_SNAPSHOT_FIELD,
} from '../../src/server-components/protocol.js';
import {
  createServerComponentsRuntime,
  ServerComponentRuntimeError,
  type ServerComponentsRuntime,
} from '../../src/server-components/runtime.js';
import { createComponentSigner } from '../../src/server-components/snapshot.js';
import {
  createDiskUploadStore,
  createUploadReferenceSigner,
  readUploadBody,
  UploadError,
  uploadRefSchema,
  type UploadReferenceClaims,
  type UploadStore,
} from '../../src/server-components/uploads.js';
import { createTestApp, type TestApplication } from '../../src/testing/app.js';

const KEY = '0123456789abcdef0123456789abcdef';
const ORIGIN = 'http://localhost';
const SNAPSHOT_ID = 'upload-snap-1';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const avatar = defineServerComponent<{ ref?: { __upload: string } }>({
  name: 'Avatar',
  stateSchema: z.object({ ref: uploadRefSchema().optional() }).strict(),
  initialState() {
    return {};
  },
  authorize() {
    return true;
  },
  render() {
    return null;
  },
});

const denied = defineServerComponent({
  name: 'Denied',
  stateSchema: z.object({}).strict(),
  initialState() {
    return {};
  },
  authorize() {
    return false;
  },
  render() {
    return null;
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'jsails-uploads-'));
}

/** A runtime with a direct disk store rooted at `dir` and a frozen clock. */
function makeRuntime(
  dir: string,
  overrides: {
    components?: Readonly<Record<string, ServerComponentDefinition<any>>>;
    maxBytes?: number;
    contentTypes?: readonly string[];
  } = {},
): { runtime: ServerComponentsRuntime; store: UploadStore } {
  const store = createDiskUploadStore({
    rootDir: dir,
    maxBytes: overrides.maxBytes,
    contentTypes: overrides.contentTypes,
  });
  const runtime = createServerComponentsRuntime({
    components: overrides.components ?? { Avatar: avatar },
    signer: createComponentSigner({ key: KEY, now: () => 0 }),
    uploads: {
      store,
      signer: createUploadReferenceSigner({ key: KEY, now: () => 0 }),
      maxBytes: overrides.maxBytes,
      contentTypes: overrides.contentTypes,
    },
  });
  return { runtime, store };
}

function makeSnapshot(component = 'Avatar', subject: string | null = null): string {
  return createComponentSigner({ key: KEY, now: () => 0 }).sign({
    v: 1,
    component,
    id: SNAPSHOT_ID,
    state: {},
    page: { path: '/avatar', params: {} },
    origin: ORIGIN,
    subject,
  });
}

function makeUploadRequest(
  _snapshot: string,
  body: FormData,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${ORIGIN}${COMPONENT_UPLOAD_ENDPOINT}`, {
    method: 'POST',
    headers: { origin: ORIGIN, [COMPONENT_CSRF_HEADER]: SNAPSHOT_ID, ...headers },
    body,
  });
}

function uploadContext(request: Request, session: Session | null = null): RequestContext {
  return {
    request,
    url: new URL(request.url),
    params: {},
    session,
  };
}

/** Collect a Node `Readable` into a buffer. */
async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function fileForm(
  snapshot: string,
  bytes: Buffer,
  name = 'avatar.png',
  type = 'image/png',
): FormData {
  const form = new FormData();
  form.set(COMPONENT_UPLOAD_SNAPSHOT_FIELD, snapshot);
  // `new Uint8Array(bytes)` copies into an ArrayBuffer-backed view, satisfying
  // the `BlobPart` constraint (a Buffer's backing store is `ArrayBufferLike`).
  form.set(COMPONENT_UPLOAD_FILE_FIELD, new File([new Uint8Array(bytes)], name, { type }));
  return form;
}

// ---------------------------------------------------------------------------
// Disk store
// ---------------------------------------------------------------------------

describe('disk upload store', () => {
  it('writes, reads back, and deletes an upload atomically', async () => {
    const dir = tempDir();
    try {
      const store = createDiskUploadStore({ rootDir: dir });
      const bytes = Buffer.from('hello upload');
      const { size } = await store.put({
        id: 'upload-1',
        subject: null,
        contentType: 'image/png',
        stream: Readable.from([bytes]),
      });
      assert.equal(size, bytes.length);

      const opened = await store.open('upload-1', null);
      assert.ok(opened);
      assert.deepEqual(await collect(opened), bytes);

      await store.delete('upload-1', null);
      assert.equal(await store.open('upload-1', null), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a content type outside the allowlist before writing', async () => {
    const dir = tempDir();
    try {
      const store = createDiskUploadStore({ rootDir: dir });
      await assert.rejects(
        () =>
          store.put({
            id: 'upload-1',
            subject: null,
            contentType: 'text/html',
            stream: Readable.from([Buffer.from('x')]),
          }),
        (error: unknown) =>
          error instanceof UploadError && error.code === 'unsupported_content_type',
      );
      assert.equal(await store.open('upload-1', null), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces the byte cap while streaming and leaves nothing behind', async () => {
    const dir = tempDir();
    try {
      const store = createDiskUploadStore({ rootDir: dir, maxBytes: 4 });
      await assert.rejects(
        () =>
          store.put({
            id: 'upload-1',
            subject: null,
            contentType: 'image/png',
            stream: Readable.from([Buffer.from('way-too-long')]),
          }),
        (error: unknown) => error instanceof UploadError && error.code === 'oversize',
      );
      assert.equal(await store.open('upload-1', null), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scopes uploads by subject tag so one subject cannot read another', async () => {
    const dir = tempDir();
    try {
      const store = createDiskUploadStore({ rootDir: dir });
      await store.put({
        id: 'upload-1',
        subject: 'subject-a',
        contentType: 'image/png',
        stream: Readable.from([Buffer.from('a')]),
      });
      assert.ok(await store.open('upload-1', 'subject-a'));
      assert.equal(await store.open('upload-1', 'subject-b'), null);
      assert.equal(await store.open('upload-1', null), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unsafe id or subject segment', async () => {
    const dir = tempDir();
    try {
      const store = createDiskUploadStore({ rootDir: dir });
      await assert.rejects(
        () =>
          store.put({
            id: '../escape',
            subject: null,
            contentType: 'image/png',
            stream: Readable.from([Buffer.from('x')]),
          }),
        UploadError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Reference signer
// ---------------------------------------------------------------------------

describe('upload reference signer', () => {
  const claims = {
    uploadId: 'upload-1',
    component: 'Avatar',
    subject: null,
    size: 12,
    contentType: 'image/png',
  };

  it('signs a reference and verifies it back', () => {
    const signer = createUploadReferenceSigner({ key: KEY, now: () => 0 });
    const token = signer.sign(claims);
    assert.equal(typeof token, 'string');
    assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.deepEqual(signer.verify(token), { ...claims, v: 1, expiresAt: 3_600_000 });
  });

  it('rejects a tampered payload', () => {
    const signer = createUploadReferenceSigner({ key: KEY, now: () => 0 });
    const token = signer.sign(claims);
    const tampered = `${token.slice(0, -1)}A`;
    assert.throws(() => signer.verify(tampered), UploadError);
  });

  it('rejects an expired reference', () => {
    const signer = createUploadReferenceSigner({ key: KEY, now: () => 0, ttlMs: 100 });
    const token = signer.sign(claims);
    assert.throws(
      () => createUploadReferenceSigner({ key: KEY, now: () => 101 }).verify(token),
      UploadError,
    );
  });

  it('does not verify a snapshot token (domain separation)', () => {
    const snapshot = makeSnapshot();
    const uploadSigner = createUploadReferenceSigner({ key: KEY, now: () => 0 });
    assert.throws(() => uploadSigner.verify(snapshot), UploadError);
  });

  it('requires a key of at least 32 bytes', () => {
    assert.throws(() => createUploadReferenceSigner({ key: 'short' }), UploadError);
  });
});

// ---------------------------------------------------------------------------
// uploadRefSchema
// ---------------------------------------------------------------------------

describe('uploadRefSchema', () => {
  it('accepts exactly { __upload: string }', () => {
    const schema = uploadRefSchema();
    assert.deepEqual(schema.parse({ __upload: 'token' }), { __upload: 'token' });
  });

  it('rejects missing, non-string, or extra fields', () => {
    const schema = uploadRefSchema();
    assert.throws(() => schema.parse({}), z.ZodError);
    assert.throws(() => schema.parse({ __upload: 123 }), z.ZodError);
    assert.throws(() => schema.parse({ __upload: 'x', extra: true }), z.ZodError);
  });
});

// ---------------------------------------------------------------------------
// readUploadBody
// ---------------------------------------------------------------------------

describe('readUploadBody', () => {
  it('parses a multipart body into a snapshot and a file stream', async () => {
    const form = fileForm('token-value', Buffer.from('file bytes'));
    const request = new Request(`${ORIGIN}${COMPONENT_UPLOAD_ENDPOINT}`, {
      method: 'POST',
      body: form,
    });
    const body = await readUploadBody(request);
    assert.equal(body.snapshot, 'token-value');
    assert.ok(body.file);
    assert.equal(body.file.contentType, 'image/png');
    assert.deepEqual(await collect(body.file.stream), Buffer.from('file bytes'));
  });

  it('rejects a non-multipart body', async () => {
    const request = new Request(`${ORIGIN}${COMPONENT_UPLOAD_ENDPOINT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    await assert.rejects(
      () => readUploadBody(request),
      (error: unknown) => error instanceof UploadError && error.code === 'invalid_input',
    );
  });

  it('rejects a body missing the snapshot field', async () => {
    const form = new FormData();
    form.set(
      COMPONENT_UPLOAD_FILE_FIELD,
      new File([new Uint8Array(Buffer.from('x'))], 'a.png', { type: 'image/png' }),
    );
    const request = new Request(`${ORIGIN}${COMPONENT_UPLOAD_ENDPOINT}`, {
      method: 'POST',
      body: form,
    });
    await assert.rejects(
      () => readUploadBody(request),
      (error: unknown) => error instanceof UploadError && error.code === 'invalid_input',
    );
  });
});

// ---------------------------------------------------------------------------
// Runtime handleUpload + resolveUpload
// ---------------------------------------------------------------------------

describe('runtime handleUpload', () => {
  it('stores an upload and returns a signed reference that resolveUpload reads back', async () => {
    const dir = tempDir();
    try {
      const { runtime, store } = makeRuntime(dir);
      const snapshot = makeSnapshot();
      const bytes = Buffer.from('avatar-bytes');
      const context = uploadContext(makeUploadRequest(snapshot, fileForm(snapshot, bytes)));

      const result = await runtime.handleUpload(context.request, context);
      assert.equal(result.status, 201);
      assert.ok(result.body.reference);
      assert.equal(result.body.error, undefined);

      const resolved = runtime.resolveUpload(result.body.reference, {
        expectedComponent: 'Avatar',
        expectedSubject: null,
      });
      assert.equal(resolved.component, 'Avatar');
      assert.equal(resolved.size, bytes.length);
      assert.equal(resolved.contentType, 'image/png');
      assert.deepEqual(await collect((await resolved.open())!), bytes);

      // The store recorded the same bytes under the derived (anonymous) subject.
      assert.deepEqual(await collect((await store.open(resolved.id, null))!), bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips through a factory-resolved store keyed by storagePath', async () => {
    const dir = tempDir();
    try {
      const store = createDiskUploadStore({ rootDir: dir });
      const runtime = createServerComponentsRuntime({
        components: { Avatar: avatar },
        signer: createComponentSigner({ key: KEY, now: () => 0 }),
        uploads: {
          store: () => store,
          signer: createUploadReferenceSigner({ key: KEY, now: () => 0 }),
        },
      });
      const snapshot = makeSnapshot();
      const bytes = Buffer.from('factory-bytes');
      const context: RequestContext = {
        ...uploadContext(makeUploadRequest(snapshot, fileForm(snapshot, bytes))),
        storagePath: '/ignored/by/the-factory',
      };

      const result = await runtime.handleUpload(context.request, context);
      assert.equal(result.status, 201);
      const resolved = runtime.resolveUpload(result.body.reference!, {
        expectedComponent: 'Avatar',
        expectedSubject: null,
        storagePath: '/ignored',
      });
      assert.deepEqual(await collect((await resolved.open())!), bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a cross-origin upload', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir);
      const snapshot = makeSnapshot();
      const request = makeUploadRequest(snapshot, fileForm(snapshot, Buffer.from('x')), {
        origin: 'https://evil.example',
      });
      const result = await runtime.handleUpload(request, uploadContext(request));
      assert.equal(result.status, 403);
      assert.equal(result.body.error?.code, 'origin_mismatch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a tampered snapshot', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir);
      const snapshot = `${makeSnapshot().slice(0, -2)}AA`;
      const request = makeUploadRequest(snapshot, fileForm(snapshot, Buffer.from('x')));
      const result = await runtime.handleUpload(request, uploadContext(request));
      assert.equal(result.status, 403);
      assert.equal(result.body.error?.code, 'invalid_snapshot');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a snapshot whose subject does not match the session', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir);
      const snapshot = makeSnapshot('Avatar', null);
      const session: Session = { id: 'someone', csrfToken: 'csrf-token', data: {}, expiresAt: 1 };
      const request = makeUploadRequest(snapshot, fileForm(snapshot, Buffer.from('x')), {
        [COMPONENT_CSRF_HEADER]: 'csrf-token',
      });
      const result = await runtime.handleUpload(request, uploadContext(request, session));
      assert.equal(result.status, 403);
      assert.equal(result.body.error?.code, 'invalid_snapshot');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a missing CSRF token', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir);
      const snapshot = makeSnapshot();
      const request = makeUploadRequest(snapshot, fileForm(snapshot, Buffer.from('x')), {
        [COMPONENT_CSRF_HEADER]: '',
      });
      const result = await runtime.handleUpload(request, uploadContext(request));
      assert.equal(result.status, 403);
      assert.equal(result.body.error?.code, 'csrf_mismatch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('denies a component whose authorize does not resolve to true', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir, { components: { Denied: denied } });
      const snapshot = makeSnapshot('Denied');
      const request = makeUploadRequest(snapshot, fileForm(snapshot, Buffer.from('x')));
      const result = await runtime.handleUpload(request, uploadContext(request));
      assert.equal(result.status, 403);
      assert.equal(result.body.error?.code, 'forbidden');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unsupported content type', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir);
      const snapshot = makeSnapshot();
      const request = makeUploadRequest(
        snapshot,
        fileForm(snapshot, Buffer.from('x'), 'evil.svg', 'image/svg+xml'),
      );
      const result = await runtime.handleUpload(request, uploadContext(request));
      assert.equal(result.status, 415);
      assert.equal(result.body.error?.code, 'unsupported_content_type');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an oversize upload with 413', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir, { maxBytes: 4 });
      const snapshot = makeSnapshot();
      const request = makeUploadRequest(snapshot, fileForm(snapshot, Buffer.from('way-too-long')));
      const result = await runtime.handleUpload(request, uploadContext(request));
      assert.equal(result.status, 413);
      assert.equal(result.body.error?.code, 'oversize');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a request missing the file field', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir);
      const snapshot = makeSnapshot();
      const form = new FormData();
      form.set(COMPONENT_UPLOAD_SNAPSHOT_FIELD, snapshot);
      const request = makeUploadRequest(snapshot, form);
      const result = await runtime.handleUpload(request, uploadContext(request));
      assert.equal(result.status, 400);
      assert.equal(result.body.error?.code, 'invalid_request');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports storage_unavailable when uploads are not configured', async () => {
    const dir = tempDir();
    try {
      const runtime = createServerComponentsRuntime({
        components: { Avatar: avatar },
        signer: createComponentSigner({ key: KEY, now: () => 0 }),
      });
      const snapshot = makeSnapshot();
      const request = makeUploadRequest(snapshot, fileForm(snapshot, Buffer.from('x')));
      const result = await runtime.handleUpload(request, uploadContext(request));
      assert.equal(result.status, 503);
      assert.equal(result.body.error?.code, 'storage_unavailable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws after close', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir);
      runtime.close();
      const snapshot = makeSnapshot();
      const request = makeUploadRequest(snapshot, fileForm(snapshot, Buffer.from('x')));
      await assert.rejects(
        () => runtime.handleUpload(request, uploadContext(request)),
        ServerComponentRuntimeError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// resolveUpload
// ---------------------------------------------------------------------------

describe('resolveUpload', () => {
  it('rejects a reference minted for a different component', () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir);
      const signer = createUploadReferenceSigner({ key: KEY, now: () => 0 });
      const reference = signer.sign({
        uploadId: 'upload-1',
        component: 'Other',
        subject: null,
        size: 1,
        contentType: 'image/png',
      });
      assert.throws(
        () => runtime.resolveUpload(reference, { expectedComponent: 'Avatar' }),
        UploadError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a reference whose subject does not match', () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir);
      const signer = createUploadReferenceSigner({ key: KEY, now: () => 0 });
      const reference = signer.sign({
        uploadId: 'upload-1',
        component: 'Avatar',
        subject: 'subject-a',
        size: 1,
        contentType: 'image/png',
      });
      assert.throws(
        () =>
          runtime.resolveUpload(reference, { expectedComponent: 'Avatar', expectedSubject: null }),
        UploadError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on a non-string reference', () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir);
      assert.throws(() => runtime.resolveUpload(123, { expectedComponent: 'Avatar' }), UploadError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deletes the stored upload', async () => {
    const dir = tempDir();
    try {
      const { runtime } = makeRuntime(dir);
      const snapshot = makeSnapshot();
      const bytes = Buffer.from('to-delete');
      const context = uploadContext(makeUploadRequest(snapshot, fileForm(snapshot, bytes)));
      const result = await runtime.handleUpload(context.request, context);
      assert.equal(result.status, 201);

      const resolved = runtime.resolveUpload(result.body.reference!, {
        expectedComponent: 'Avatar',
        expectedSubject: null,
      });
      await resolved.delete();
      assert.equal(await resolved.open(), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP mount and body-limit exemption
// ---------------------------------------------------------------------------

describe('server components upload HTTP transport', () => {
  it('mounts the upload route and accepts an upload larger than the JSON body cap', async () => {
    const dir = tempDir();
    let app: TestApplication | undefined;
    try {
      app = await createTestApp({
        config: {
          rootDir: dir,
          port: 0,
          storage: 'storage',
          extensions: [
            serverComponentsPlugin({
              components: { Avatar: avatar },
              signingKey: KEY,
              uploads: {},
            }),
          ],
        },
      });

      // Mint a snapshot with the same key/clock the extension uses (default now).
      const snapshot = createComponentSigner({ key: KEY }).sign({
        v: 1,
        component: 'Avatar',
        id: SNAPSHOT_ID,
        state: {},
        page: { path: '/avatar', params: {} },
        origin: app.origin,
        subject: null,
      });

      // 1.5 MiB exceeds the default 1 MiB JSON/API body cap; the upload route
      // must be exempt from that cap and accept it via the store's own limit.
      const bytes = Buffer.alloc(Math.floor(1.5 * 1024 * 1024), 0x41);
      const form = fileForm(snapshot, bytes);
      const response = await app.request(COMPONENT_UPLOAD_ENDPOINT, {
        method: 'POST',
        headers: { origin: app.origin, [COMPONENT_CSRF_HEADER]: SNAPSHOT_ID },
        body: form,
      });

      const raw = await response.text();
      assert.equal(response.status, 201, raw);
      const body = JSON.parse(raw) as { reference: string; error?: { code: string } };
      assert.ok(body.reference);
      assert.equal(body.error, undefined);

      const claims: UploadReferenceClaims = createUploadReferenceSigner({ key: KEY }).verify(
        body.reference,
      );
      assert.equal(claims.component, 'Avatar');
      assert.equal(claims.size, bytes.length);
      assert.equal(claims.contentType, 'image/png');
    } finally {
      await app?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a cross-origin upload through the mounted route', async () => {
    const dir = tempDir();
    let app: TestApplication | undefined;
    try {
      app = await createTestApp({
        config: {
          rootDir: dir,
          port: 0,
          storage: 'storage',
          extensions: [
            serverComponentsPlugin({
              components: { Avatar: avatar },
              signingKey: KEY,
              uploads: {},
            }),
          ],
        },
      });
      const snapshot = createComponentSigner({ key: KEY }).sign({
        v: 1,
        component: 'Avatar',
        id: SNAPSHOT_ID,
        state: {},
        page: { path: '/avatar', params: {} },
        origin: app.origin,
        subject: null,
      });
      const response = await app.request(COMPONENT_UPLOAD_ENDPOINT, {
        method: 'POST',
        headers: { origin: 'https://evil.example', [COMPONENT_CSRF_HEADER]: SNAPSHOT_ID },
        body: fileForm(snapshot, Buffer.from('x')),
      });
      assert.equal(response.status, 403);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'origin_mismatch');
    } finally {
      await app?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
