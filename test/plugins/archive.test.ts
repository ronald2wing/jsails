import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { describe, it } from 'node:test';

import {
  ArchiveError,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_TOTAL_BYTES,
  extractTarGz,
  type ArchiveErrorCode,
} from '../../src/plugins/archive.js';

const BLOCK_SIZE = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface TarEntrySpec {
  name: string;
  content?: string | Uint8Array;
  typeflag?: string;
  prefix?: string;
  magic?: string;
}

/** Write `value` into a zero-padded field of `length` bytes. */
function field(value: string, length: number): Uint8Array {
  const out = new Uint8Array(length).fill(0);
  out.set(encoder.encode(value).subarray(0, length), 0);
  return out;
}

/** Write a NUL-terminated octal integer into a field of `length` bytes. */
function octalField(value: number, length: number): Uint8Array {
  const out = new Uint8Array(length).fill(0x30); // ASCII '0'
  const digits = value.toString(8);
  const start = length - 1 - digits.length;
  for (let i = 0; i < digits.length; i += 1) {
    out[start + i] = digits.charCodeAt(i);
  }
  out[length - 1] = 0;
  return out;
}

/** Build a single 512-byte ustar header (checksum left as spaces; unused here). */
function tarHeader(spec: TarEntrySpec): Uint8Array {
  const block = new Uint8Array(BLOCK_SIZE);
  const content =
    typeof spec.content === 'string'
      ? encoder.encode(spec.content)
      : (spec.content ?? new Uint8Array(0));

  block.set(field(spec.name, 100), 0);
  block.set(octalField(0o100644, 8), 100); // mode
  block.set(octalField(0, 8), 108); // uid
  block.set(octalField(0, 8), 116); // gid
  block.set(octalField(content.length, 12), 124); // size
  block.set(octalField(0, 12), 136); // mtime
  block.set(field('        ', 8), 148); // checksum (ignored by the extractor)
  block[156] = (spec.typeflag ?? '0').charCodeAt(0);
  block.set(field(spec.magic ?? 'ustar', 6), 257); // 'ustar' + NUL
  block.set(field('00', 2), 263); // version
  block.set(field(spec.prefix ?? '', 155), 345);
  return block;
}

/** Build one header plus its padded data. */
function tarEntry(spec: TarEntrySpec): Uint8Array {
  const content =
    typeof spec.content === 'string'
      ? encoder.encode(spec.content)
      : (spec.content ?? new Uint8Array(0));
  const padded = Math.ceil(content.length / BLOCK_SIZE) * BLOCK_SIZE;
  const out = new Uint8Array(BLOCK_SIZE + padded);
  out.set(tarHeader(spec), 0);
  out.set(content, BLOCK_SIZE);
  return out;
}

/** Concatenate entries plus the two zero end-of-archive blocks. */
function tar(...specs: TarEntrySpec[]): Uint8Array {
  const parts = specs.map(tarEntry);
  const end = new Uint8Array(BLOCK_SIZE * 2);
  const total = parts.reduce((n, part) => n + part.length, end.length);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  out.set(end, offset);
  return out;
}

/** Build a gzip-compressed tar archive. */
function tgz(...specs: TarEntrySpec[]): Uint8Array {
  return gzipSync(tar(...specs));
}

function decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

function assertArchiveError(fn: () => unknown, code: ArchiveErrorCode): void {
  assert.throws(fn, (error: unknown) => error instanceof ArchiveError && error.code === code);
}

describe('extractTarGz', () => {
  it('extracts regular files and skips directories, preserving order', () => {
    const archive = tgz(
      { name: 'pkg/', typeflag: '5' },
      { name: 'pkg/index.js', content: 'console.log(1)' },
      { name: 'pkg/readme.md', content: 'hello' },
    );

    const entries = extractTarGz(archive);
    assert.deepEqual([...entries.keys()], ['pkg/index.js', 'pkg/readme.md']);
    assert.equal(decode(entries.get('pkg/index.js')!), 'console.log(1)');
    assert.equal(decode(entries.get('pkg/readme.md')!), 'hello');
  });

  it('extracts an empty file', () => {
    const entries = extractTarGz(tgz({ name: 'empty', content: '' }));
    assert.equal(entries.size, 1);
    assert.equal(entries.get('empty')!.length, 0);
  });

  it('accepts the GNU contiguous-file and NUL type flags', () => {
    const entries = extractTarGz(
      tgz(
        { name: 'a', typeflag: '7', content: 'seven' },
        { name: 'b', typeflag: '\0', content: 'nul' },
      ),
    );
    assert.deepEqual([...entries.keys()], ['a', 'b']);
  });

  it('decodes a GNU long name (>100 bytes) from an L marker entry', () => {
    const longName = `pkg/${'a'.repeat(150)}.js`;
    const entries = extractTarGz(
      tgz({ name: '././@LongLink', typeflag: 'L', content: longName }, { name: '', content: 'x' }),
    );
    assert.deepEqual([...entries.keys()], [longName]);
  });

  it('rejects data that is not valid gzip', () => {
    assertArchiveError(() => extractTarGz(new Uint8Array([1, 2, 3, 4])), 'invalid_gzip');
  });

  it('rejects a header with a non-ustar magic', () => {
    assertArchiveError(
      () => extractTarGz(tgz({ name: 'a', content: 'x', magic: 'xxxxx' })),
      'invalid_header',
    );
  });

  it('rejects a path that escapes its root', () => {
    assertArchiveError(
      () => extractTarGz(tgz({ name: '../evil.js', content: 'x' })),
      'unsafe_path',
    );
  });

  it('rejects a path that escapes via a GNU long name', () => {
    assertArchiveError(
      () =>
        extractTarGz(
          tgz(
            { name: '././@LongLink', typeflag: 'L', content: '../evil.js' },
            { name: '', content: 'x' },
          ),
        ),
      'unsafe_path',
    );
  });

  it('rejects a Windows-style path', () => {
    assertArchiveError(
      () => extractTarGz(tgz({ name: 'C:\\evil.js', content: 'x' })),
      'unsafe_path',
    );
  });

  it('rejects a symbolic link', () => {
    assertArchiveError(() => extractTarGz(tgz({ name: 'link', typeflag: '2' })), 'symlink');
  });

  it('rejects a hard link', () => {
    assertArchiveError(() => extractTarGz(tgz({ name: 'link', typeflag: '1' })), 'hardlink');
  });

  it('rejects a device node', () => {
    assertArchiveError(() => extractTarGz(tgz({ name: 'dev', typeflag: '3' })), 'device');
  });

  it('rejects a directory that carries content', () => {
    assertArchiveError(
      () => extractTarGz(tgz({ name: 'dir/', typeflag: '5', content: 'payload' })),
      'directory_with_content',
    );
  });

  it('rejects an unknown entry type', () => {
    assertArchiveError(
      () => extractTarGz(tgz({ name: 'pax', typeflag: 'x' })),
      'unsupported_entry_type',
    );
  });

  it('rejects a duplicate entry name', () => {
    assertArchiveError(
      () => extractTarGz(tgz({ name: 'a.js', content: '1' }, { name: 'a.js', content: '2' })),
      'duplicate_entry',
    );
  });

  it('rejects a truncated archive', () => {
    const full = tar({ name: 'big.txt', content: 'x'.repeat(BLOCK_SIZE) });
    // Keep the header but drop the end blocks and part of the single data block.
    const truncated = full.slice(0, BLOCK_SIZE * 2 - 100);
    assertArchiveError(() => extractTarGz(gzipSync(truncated)), 'truncated');
  });

  it('enforces the entry-count limit', () => {
    const archive = tgz(
      { name: 'a.js', content: '1' },
      { name: 'b.js', content: '2' },
      { name: 'c.js', content: '3' },
    );
    assertArchiveError(() => extractTarGz(archive, { maxEntries: 2 }), 'too_many_entries');
  });

  it('enforces the total-size limit while gunzipping', () => {
    const archive = tgz({ name: 'big.txt', content: 'x'.repeat(1000) });
    assertArchiveError(() => extractTarGz(archive, { maxTotalBytes: 100 }), 'too_large');
  });

  it('rejects non-positive limits', () => {
    const archive = tgz({ name: 'a.js', content: '1' });
    assertArchiveError(() => extractTarGz(archive, { maxEntries: 0 }), 'invalid_options');
    assertArchiveError(() => extractTarGz(archive, { maxTotalBytes: 0 }), 'invalid_options');
  });

  it('exposes the documented default limits', () => {
    assert.equal(DEFAULT_MAX_ENTRIES, 1000);
    assert.equal(DEFAULT_MAX_TOTAL_BYTES, 64 * 1024 * 1024);
  });
});
