/**
 * Server-component download unit tests: the `download()` declaration, the
 * `isDownload` structural guard, and the purpose-separated download-reference
 * signer (sign/verify round-trip, tampering, expiry, subject handling).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DownloadError,
  createDownloadReferenceSigner,
  download,
  isDownload,
  type DownloadReferenceSigner,
} from '../../src/server-components/downloads.js';

const KEY = '0123456789abcdef0123456789abcdef';

function makeSigner(now: () => number = () => 1000, ttlMs = 5000): DownloadReferenceSigner {
  return createDownloadReferenceSigner({ key: KEY, now, ttlMs });
}

describe('download() declaration', () => {
  it('accepts an id and defaults filename/contentType', () => {
    const d = download('report-123');
    assert.deepEqual(d, {
      __jsailsDownload: true,
      id: 'report-123',
      filename: 'report-123',
      contentType: 'application/octet-stream',
    });
  });

  it('accepts an explicit filename and contentType', () => {
    const d = download('report-123', {
      filename: 'quarterly.pdf',
      contentType: 'application/pdf',
    });
    assert.equal(d.filename, 'quarterly.pdf');
    assert.equal(d.contentType, 'application/pdf');
  });

  it('rejects an empty id', () => {
    assert.throws(
      () => download(''),
      (error: unknown) => error instanceof DownloadError,
    );
  });

  it('rejects an id with unsafe characters', () => {
    assert.throws(
      () => download('report../123'),
      (error: unknown) => error instanceof DownloadError,
    );
  });

  it('rejects a filename with whitespace/control/quote characters', () => {
    for (const bad of ['has space', 'quote"name', 'crlf\nname', 'tab\tname']) {
      assert.throws(
        () => download('report', { filename: bad }),
        (error: unknown) => error instanceof DownloadError,
        `expected rejection for filename ${JSON.stringify(bad)}`,
      );
    }
  });

  it('rejects a malformed contentType', () => {
    assert.throws(
      () => download('report', { contentType: 'not-a-content-type' }),
      (error: unknown) => error instanceof DownloadError,
    );
  });
});

describe('isDownload guard', () => {
  it('accepts a download() value', () => {
    assert.equal(isDownload(download('x')), true);
  });

  it('rejects non-download values', () => {
    assert.equal(isDownload(undefined), false);
    assert.equal(isDownload(null), false);
    assert.equal(isDownload('download'), false);
    assert.equal(isDownload({}), false);
    assert.equal(isDownload({ __jsailsDownload: false }), false);
    assert.equal(isDownload({ id: 'x' }), false);
  });
});

describe('download-reference signer', () => {
  it('round-trips every claim and computes expiresAt', () => {
    const signer = makeSigner();
    const token = signer.sign({
      downloadId: 'file-1',
      component: 'Counter',
      subject: 'subj-tag',
      filename: 'report.pdf',
      contentType: 'application/pdf',
    });
    assert.deepEqual(signer.verify(token), {
      v: 1,
      downloadId: 'file-1',
      component: 'Counter',
      subject: 'subj-tag',
      filename: 'report.pdf',
      contentType: 'application/pdf',
      expiresAt: 6000,
    });
  });

  it('round-trips a null (anonymous) subject', () => {
    const signer = makeSigner();
    const token = signer.sign({
      downloadId: 'file-1',
      component: 'Counter',
      subject: null,
      filename: 'report.pdf',
      contentType: 'application/pdf',
    });
    assert.equal(signer.verify(token).subject, null);
  });

  it('rejects a tampered payload', () => {
    const signer = makeSigner();
    const token = signer.sign({
      downloadId: 'file-1',
      component: 'Counter',
      subject: null,
      filename: 'report.pdf',
      contentType: 'application/pdf',
    });
    const [payload, signature] = token.split('.') as [string, string];
    const tampered = Buffer.from(payload, 'base64url').toString('utf8').replace('file-1', 'file-2');
    const forged = `${Buffer.from(tampered, 'utf8').toString('base64url')}.${signature}`;
    assert.throws(
      () => signer.verify(forged),
      (error: unknown) => error instanceof DownloadError,
    );
  });

  it('rejects a token signed with a different key', () => {
    const a = createDownloadReferenceSigner({
      key: '0123456789abcdef0123456789abcdef',
      now: () => 1000,
    });
    const b = createDownloadReferenceSigner({
      key: 'fedcba9876543210fedcba9876543210',
      now: () => 1000,
    });
    const token = a.sign({
      downloadId: 'file-1',
      component: 'Counter',
      subject: null,
      filename: 'report.pdf',
      contentType: 'application/pdf',
    });
    assert.throws(
      () => b.verify(token),
      (error: unknown) => error instanceof DownloadError,
    );
  });

  it('rejects an expired token', () => {
    let now = 1000;
    const signer = createDownloadReferenceSigner({ key: KEY, now: () => now, ttlMs: 5000 });
    const token = signer.sign({
      downloadId: 'file-1',
      component: 'Counter',
      subject: null,
      filename: 'report.pdf',
      contentType: 'application/pdf',
    });
    now = 7000;
    assert.throws(
      () => signer.verify(token),
      (error: unknown) => error instanceof DownloadError,
    );
  });

  it('rejects a short key at construction', () => {
    assert.throws(
      () => createDownloadReferenceSigner({ key: 'short' }),
      (error: unknown) => error instanceof DownloadError,
    );
  });

  it('rejects a malformed (non-string) token', () => {
    const signer = makeSigner();
    assert.throws(
      () => signer.verify(42 as unknown as string),
      (error: unknown) => error instanceof DownloadError,
    );
  });
});
