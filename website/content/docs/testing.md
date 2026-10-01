---
title: Testing
order: 12
---

# Testing

JSails ships a **server-only** test subpath, `jsails/testing`, that assembles a
real `Application` in-process and routes requests through the **same Hono
pipeline `serve` uses**. No HTTP server listens, no broadcast transport is
attached, and no Valkey connection is opened automatically. Pages render through
the built-in Preact renderer (or the configured renderer) and API routes go
through the normal default-deny / session / CSRF pipeline, so server HTML and
API behavior are the real output.

Importing `jsails/testing` pulls in the application runtime (Hono, page
rendering, the config loader), so it is never part of the browser-safe root
entry.

## The `createTestApp` surface

`createTestApp(options?)` resolves config like the runtime. Pass a raw `config`
object (validated by `validateAppConfig`) **or** a `configPath` to a compiled
config module (loaded by `loadAppConfig`, default `jsails.app.js`) resolved
against `cwd`. The two are mutually exclusive.

The request origin is the explicit `origin` (a validated `http(s)` origin — no
credentials, path, query, or fragment) when given, else the configured
`publicOrigin`, else the `TEST_ORIGIN` environment variable, else
`http://localhost` (`DEFAULT_TEST_ORIGIN`).

- `fetch(request)` — route a native `Request` directly; the escape hatch for
  deliberately exercising a non-test origin in-process.
- `request(path, init?)` — build a `Request` **pinned to the resolved origin**
  and route it; rejects a path that resolves off-origin, carries credentials, or
  uses a non-`http(s)` scheme before any handler runs. Returns the `Response` for
  **any** status, so negative HTTP assertions use it.
- `json<T>(path, init?)` — `request` plus a 2xx check and JSON parse; rejects
  with `TestRequestError` on a non-2xx status or invalid JSON. Its message never
  embeds the response body, the underlying cause, or the request URL (which may
  carry secrets).
- `close()` — idempotent teardown. Pass `lifecycle: t` (a `node:test`
  `TestContext`) to register `t.after(...)`, so the app closes automatically when
  each test finishes.

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTestApp } from 'jsails/testing';

test('home page is served as HTML', { timeout: 30_000 }, async (t) => {
  const app = await createTestApp({ lifecycle: t });

  const response = await app.request('/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);

  // The response body is caller-owned: consume it explicitly.
  const html = await response.text();
  assert.match(html, /<title>JSails Starter<\/title>/);

  const missing = await app.request('/does-not-exist');
  assert.equal(missing.status, 404); // request() returns negative statuses.
});
```

## No sandbox

Loading a trusted app config module and running its `setup` / extensions can open
whatever connections the app config selects — a database, Valkey, or any other
service. `close()` tears the app down (services and the extension registry are
fresh per call), but there is **no automatic database rollback**, no global
module reset, and no cookie jar. Point each test at isolated fixtures and seeds
it owns; cookies, sessions, and other state persist only when the test sets them
explicitly.

The test surface also does not exercise Socket.IO or any native broadcast-adapter
transport, because no transport is attached in-process. Core HTTP producer errors
remain sanitized, and the testing helpers add no JSON CLI flags.

## The native test suite

The generated starter's `npm test` is the default, browser-free path. It runs
`tsc -p tsconfig.json` (the server project) and then
`node scripts/run-tests.mjs`, which collects only compiled `*.test.js` files
under `dist/test/` (never a Playwright `*.spec.js`) and forwards extra flags to
`node --test`.

Tests use the built-in `node:test` runner and native `node:assert/strict` — no
third-party framework.

```sh
npm test
npm run test:report   # spec reporter on stdout + JUnit XML at test-results/junit.xml
```

`npm run test:report` runs the same tests with a spec reporter on stdout plus a
JUnit XML report at `test-results/junit.xml`; `--enable-source-maps` maps failure
stacks back to the original TypeScript source locations. `npm run check` remains
the compiler/client/static-build check (`typecheck` then `build`); it does **not**
execute the native app test suite.

The generated `test/app.test.ts` cases are shared by humans and AI agents: plain,
readable `node:test` examples that document server behavior both audiences can
extend.

## Browser tests (optional)

`npm run test:browser` runs `npm run build && playwright test`. It is an optional
developer/AI UI tool, never part of the default `npm test` path:
`@playwright/test` is a starter devDependency, and there is **no automatic
browser download** — set `JSAILS_BROWSER_PATH` to an installed Chrome/Chromium or
run `npx playwright install chromium` yourself.

```sh
JSAILS_BROWSER_PATH=/path/to/chrome npm run test:browser
```

Playwright starts the already-built app on an isolated local server
(`127.0.0.1:4173` by default; override with `JSAILS_TEST_PORT`) and never reuses
an existing service. Screenshots and traces require a browser. Failure
screenshots are attached to the test; traces are opt-in only with
`JSAILS_TRACE=1`. The JSON report lands in `test-results/results.json` and the
HTML report in `playwright-report/`. Both directories are git-ignored because
reports, screenshots, and traces can embed private UI, console, and network data.

The generated browser specs cover the counter island, the native `<dialog>`,
Home/About soft navigation, adding a task through the `task-list` backend action,
rejecting a blank task (422), a mid-edit in-flight navigation, and the native
opt-out / modified-click cases.

## End-to-end verification

Two opt-in harnesses exercise the framework beyond unit tests. Neither is
triggered by a CLI command, and neither is part of `check`/`test`.

```sh
npm run verify:starter              # pack + create --install + check + native tests + browser QA
npm run verify:starter -- --skip-browser
npm run verify:integrations         # env-gated live-service harness
```

`npm run verify:starter` builds the framework, `npm pack`s it, invokes the real
`jsails create --install` with a `file:` tarball dependency into a temp fixture,
imports the *packaged* `createStarterFiles`, runs the fixture's `check`,
validates the exported `out/`, then runs the fixture's `test:report` native suite
(a **pass** plus an `expected-failure` negative proof) and, in the default full
run, drives browser QA against `jsails serve`, a pure static serve of `out/`, and
a live `jsails dev` run. `--skip-browser` runs that same
pack/install/check/native-test pipeline but records each of the five browser
stages as an explicit `skipped` — never run, never probed — and launches **0**
browsers.

`npm run verify:integrations` is **opt-in** and env-gated: it exercises the four
external-service seams (database, jobs, broadcast, Docker) against real services
the operator points at via `JSAILS_TEST_*` variables. Every stage skips cleanly
when its variables are absent (the run exits 0), and a stage that is enabled but
then fails exits non-zero. It requires an already-built `dist/`.

## Next steps

- [Deploy](/docs/deploy) — ship the app you just tested.
