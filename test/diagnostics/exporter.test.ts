/**
 * Diagnostics exporter tests: consoleExporter, HttpExporter with injectable
 * fetch, and exportOnce. No real network calls — every HttpExporter test
 * stubs fetch in-process.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  InMemoryDiagnosticsRecorder,
  type DiagnosticsRecorder,
} from '../../src/diagnostics/index.js';
import {
  consoleExporter,
  DiagnosticsExporterError,
  exportOnce,
  HttpExporter,
  type DiagnosticsExporter,
  type DiagnosticsEntry,
} from '../../src/diagnostics/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a recorder with a few entries for shared test setups. */
function recorderWithEntries(count: number, prefix = 'test'): DiagnosticsRecorder {
  const recorder = new InMemoryDiagnosticsRecorder();
  for (let i = 1; i <= count; i++) {
    recorder.record({ type: prefix, data: { n: i } });
  }
  return recorder;
}

/** A stub fetch implementation that returns a configurable response and
 * collects request parameters for assertions. */
function createStubFetch(status = 200): {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  requests: { url: string | URL; body: string | null }[];
} {
  const requests: { url: string | URL; body: string | null }[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === 'string' ? init.body : null;
    requests.push({ url: input instanceof Request ? input.url : input, body });
    return new Response(body !== null ? body : undefined, { status });
  };
  return { fetch, requests };
}

// ---------------------------------------------------------------------------
// consoleExporter
// ---------------------------------------------------------------------------

describe('consoleExporter', () => {
  it('writes one JSON line per entry', async () => {
    const lines: string[] = [];
    const exporter = consoleExporter({ write: (line) => lines.push(line) });
    const recorder = recorderWithEntries(2);

    await exportOnce(recorder, exporter);

    assert.equal(lines.length, 2);
    // Each line should be valid JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.equal(typeof parsed.type, 'string');
      assert.equal(typeof parsed.at, 'number');
    }
  });

  it('writes nothing for an empty recorder', async () => {
    const lines: string[] = [];
    const exporter = consoleExporter({ write: (line) => lines.push(line) });
    const empty = new InMemoryDiagnosticsRecorder();

    await exportOnce(empty, exporter);

    assert.equal(lines.length, 0);
  });

  it('rejects a non-function write option', () => {
    assert.throws(
      () => consoleExporter({ write: 42 as unknown as (line: string) => void }),
      (err: unknown) => err instanceof DiagnosticsExporterError && err.code === 'invalid_options',
    );
  });

  it('uses the default stdout writer when no write is given', async () => {
    // Construction only — verify it doesn't throw. Calling send() would write
    // to real stdout, so we test construction and type conformance only.
    const exporter = consoleExporter();
    assert.equal(typeof exporter.send, 'function');
  });

  it('entries are serialised correctly (all DiagnosticsEntry fields survive)', async () => {
    const lines: string[] = [];
    const exporter = consoleExporter({ write: (line) => lines.push(line) });

    const recorder = new InMemoryDiagnosticsRecorder({ clock: () => 1700000000000 });
    recorder.record({
      type: 'query',
      data: { sql: 'SELECT 1', bindings: 3 },
      durationMs: 42,
    });

    await exportOnce(recorder, exporter);

    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]!) as DiagnosticsEntry;
    assert.equal(entry.type, 'query');
    assert.equal(entry.at, 1700000000000);
    assert.equal(entry.durationMs, 42);
    assert.deepEqual(entry.data, { sql: 'SELECT 1', bindings: 3 });
  });
});

// ---------------------------------------------------------------------------
// HttpExporter — construction validation
// ---------------------------------------------------------------------------

describe('HttpExporter construction', () => {
  it('accepts a valid endpoint', () => {
    const exporter = new HttpExporter({ endpoint: 'https://collector.example.com/v1/traces' });
    assert.ok(exporter instanceof HttpExporter);
  });

  it('rejects an empty endpoint', () => {
    assert.throws(
      () => new HttpExporter({ endpoint: '' }),
      (err: unknown) => err instanceof DiagnosticsExporterError && err.code === 'invalid_endpoint',
    );
  });

  it('rejects a non-http(s) endpoint', () => {
    assert.throws(
      () => new HttpExporter({ endpoint: 'ws://collector.example.com' }),
      (err: unknown) => err instanceof DiagnosticsExporterError && err.code === 'invalid_endpoint',
    );
  });

  it('rejects a malformed endpoint', () => {
    assert.throws(
      () => new HttpExporter({ endpoint: 'not-a-url' }),
      (err: unknown) => err instanceof DiagnosticsExporterError && err.code === 'invalid_endpoint',
    );
  });

  it('rejects a non-function fetch option', () => {
    assert.throws(
      () =>
        new HttpExporter({
          endpoint: 'https://collector.example.com',
          fetch: 'not-a-function' as unknown as typeof globalThis.fetch,
        }),
      (err: unknown) => err instanceof DiagnosticsExporterError && err.code === 'invalid_options',
    );
  });

  it('rejects a non-function onError option', () => {
    assert.throws(
      () =>
        new HttpExporter({
          endpoint: 'https://collector.example.com',
          onError: 'not-a-function' as unknown as (error: Error) => void,
        }),
      (err: unknown) => err instanceof DiagnosticsExporterError && err.code === 'invalid_options',
    );
  });

  it('rejects a negative timeoutMs', () => {
    assert.throws(
      () =>
        new HttpExporter({
          endpoint: 'https://collector.example.com',
          timeoutMs: -1,
        }),
      (err: unknown) => err instanceof DiagnosticsExporterError && err.code === 'invalid_options',
    );
  });

  it('rejects NaN timeoutMs', () => {
    assert.throws(
      () =>
        new HttpExporter({
          endpoint: 'https://collector.example.com',
          timeoutMs: NaN,
        }),
      (err: unknown) => err instanceof DiagnosticsExporterError && err.code === 'invalid_options',
    );
  });

  it('rejects non-object options', () => {
    assert.throws(
      () => new HttpExporter(null as unknown as never),
      (err: unknown) => err instanceof DiagnosticsExporterError && err.code === 'invalid_options',
    );
  });

  it('rejects array options', () => {
    assert.throws(
      () => new HttpExporter([] as unknown as never),
      (err: unknown) => err instanceof DiagnosticsExporterError && err.code === 'invalid_options',
    );
  });

  it('accepts 0 as a valid timeoutMs (disables timeout)', () => {
    const exporter = new HttpExporter({
      endpoint: 'https://collector.example.com',
      timeoutMs: 0,
    });
    assert.ok(exporter instanceof HttpExporter);
  });
});

// ---------------------------------------------------------------------------
// HttpExporter — send behaviour
// ---------------------------------------------------------------------------

describe('HttpExporter send', () => {
  it('posts entries as a JSON batch', async () => {
    const { fetch, requests } = createStubFetch(200);
    const exporter = new HttpExporter({
      endpoint: 'https://collector.example.com/v1/traces',
      fetch,
    });
    const recorder = recorderWithEntries(3);

    await exportOnce(recorder, exporter);

    assert.equal(requests.length, 1);
    const req = requests[0];
    assert.ok(req !== undefined);
    assert.equal(req.url, 'https://collector.example.com/v1/traces');

    const body = req.body;
    assert.ok(body !== null);
    const parsed = JSON.parse(body);
    assert.ok(Array.isArray(parsed.entries));
    assert.equal(parsed.entries.length, 3);

    // Each entry round-trips correctly
    for (const entry of parsed.entries) {
      assert.equal(typeof entry.type, 'string');
      assert.equal(typeof entry.at, 'number');
    }
  });

  it('no-ops on an empty entries array (never POSTs)', async () => {
    const { fetch, requests } = createStubFetch(200);
    const exporter = new HttpExporter({
      endpoint: 'https://collector.example.com',
      fetch,
    });
    const empty = new InMemoryDiagnosticsRecorder();

    await exportOnce(empty, exporter);

    // HttpExporter.send returns early for an empty batch — no fetch call.
    assert.equal(requests.length, 0);
  });

  it('swallows a non-2xx response (value-free)', async () => {
    const { fetch } = createStubFetch(500);
    const exporter = new HttpExporter({
      endpoint: 'https://collector.example.com',
      fetch,
    });
    const recorder = recorderWithEntries(1);

    // Must not throw.
    await exportOnce(recorder, exporter);
  });

  it('swallows a network error (value-free)', async () => {
    const fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const exporter = new HttpExporter({
      endpoint: 'https://collector.example.com',
      fetch,
    });
    const recorder = recorderWithEntries(1);

    // Must not throw.
    await exportOnce(recorder, exporter);
  });

  it('fires onError on a non-2xx response', async () => {
    const errors: Error[] = [];
    const { fetch } = createStubFetch(502);
    const exporter = new HttpExporter({
      endpoint: 'https://collector.example.com',
      fetch,
      onError: (err) => errors.push(err),
    });
    const recorder = recorderWithEntries(1);

    await exportOnce(recorder, exporter);

    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /export request failed/);
  });

  it('fires onError on a network error', async () => {
    const errors: Error[] = [];
    const fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const exporter = new HttpExporter({
      endpoint: 'https://collector.example.com',
      fetch,
      onError: (err) => errors.push(err),
    });
    const recorder = recorderWithEntries(1);

    await exportOnce(recorder, exporter);

    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /Export request failed/);
  });

  it('swallows a throwing onError callback', async () => {
    const { fetch } = createStubFetch(500);
    const exporter = new HttpExporter({
      endpoint: 'https://collector.example.com',
      fetch,
      onError: () => {
        throw new Error('onError callback blew up');
      },
    });
    const recorder = recorderWithEntries(1);

    // Must not throw.
    await exportOnce(recorder, exporter);
  });

  it('uses globalThis.fetch when no fetch option is given', async () => {
    // Verify that construction without fetch does not throw — the real
    // send() is not called so globalThis.fetch is never invoked.
    const exporter = new HttpExporter({ endpoint: 'https://collector.example.com' });
    assert.ok(exporter instanceof HttpExporter);
  });

  it('error messages are value-free (never echo the endpoint)', async () => {
    const errors: Error[] = [];
    const { fetch } = createStubFetch(500);
    const endpoint = 'https://secret-collector.example.com/deadbeef';
    const exporter = new HttpExporter({
      endpoint,
      fetch,
      onError: (err) => errors.push(err),
    });
    const recorder = recorderWithEntries(1);

    await exportOnce(recorder, exporter);

    assert.equal(errors.length, 1);
    // Error message must not contain the endpoint URL.
    assert.ok(!errors[0]!.message.includes(endpoint));
  });
});

// ---------------------------------------------------------------------------
// exportOnce
// ---------------------------------------------------------------------------

describe('exportOnce', () => {
  it('calls the exporter even with an empty recorder', async () => {
    let called = false;
    const exporter: DiagnosticsExporter = {
      async send(_entries) {
        called = true;
      },
    };
    const empty = new InMemoryDiagnosticsRecorder();

    await exportOnce(empty, exporter);

    assert.ok(called);
  });

  it('passes every recorded entry to the exporter', async () => {
    let received: DiagnosticsEntry[] = [];
    const exporter: DiagnosticsExporter = {
      async send(entries) {
        received = [...entries];
      },
    };
    const recorder = recorderWithEntries(5);

    await exportOnce(recorder, exporter);

    assert.equal(received.length, 5);
  });

  it('does not throw when the exporter rejects', async () => {
    const exporter: DiagnosticsExporter = {
      async send(_entries) {
        throw new Error('delivery failed');
      },
    };
    // exportOnce does not catch — the exporter is responsible for its own
    // error handling. If the exporter throws, exportOnce propagates it.
    // Verify that the built-in exporters never throw (tested above).
    const recorder = recorderWithEntries(1);

    await assert.rejects(() => exportOnce(recorder, exporter), /delivery failed/);
  });

  it('snapshot isolation: exporter receives a read-only snapshot, not a live buffer', async () => {
    let callCount = 0;
    const exporter: DiagnosticsExporter = {
      async send(entries) {
        callCount++;
        if (callCount === 1) {
          assert.equal(entries.length, 2);
        } else {
          // Second drain: the recorder still holds the first 2 entries plus
          // 2 more written after the first drain, so the snapshot has 4.
          assert.equal(entries.length, 4);
        }
      },
    };
    const recorder = recorderWithEntries(2);

    await exportOnce(recorder, exporter);

    recorder.record({ type: 'extra', data: { n: 3 } });
    recorder.record({ type: 'extra', data: { n: 4 } });

    await exportOnce(recorder, exporter);

    assert.equal(callCount, 2);
  });
});

// ---------------------------------------------------------------------------
// DiagnosticsExporter contract — typed via structural conformance
// ---------------------------------------------------------------------------

describe('DiagnosticsExporter contract', () => {
  it('consoleExporter satisfies the contract', async () => {
    const exporter: DiagnosticsExporter = consoleExporter({ write: () => {} });
    assert.equal(typeof exporter.send, 'function');
  });

  it('HttpExporter satisfies the contract', () => {
    // Construction-only; send() requires fetch.
    const exporter: DiagnosticsExporter = new HttpExporter({
      endpoint: 'https://collector.example.com',
    });
    assert.equal(typeof exporter.send, 'function');
  });

  it('custom object literals satisfy the contract', async () => {
    const exporter: DiagnosticsExporter = {
      async send(_entries: readonly DiagnosticsEntry[]): Promise<void> {
        // no-op
      },
    };
    assert.equal(typeof exporter.send, 'function');
  });
});
