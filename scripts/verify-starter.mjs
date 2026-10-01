/**
 * Opt-in end-to-end starter verification.
 *
 * Builds the framework, packs it into a tarball, generates a starter fixture by
 * invoking the *real* `jsails create` CLI (with `--name` and a `file:` tarball
 * `--jsails-dependency`, and `--install` exercised through the real CLI), then
 * verifies the generated project end to end:
 *
 *  1. the framework typechecks and builds;
 *  2. `npm pack` produces a tarball carrying `dist`, `templates/starter`, and
 *     `AGENTS.md`;
 *  3. `jsails create <dir> --name ... --jsails-dependency file:<tarball>
 *     --install` scaffolds the starter and runs a real `npm install` through
 *     the CLI (isolated via `npm_config_ignore_scripts` / `npm_config_audit` /
 *     `npm_config_fund` env so a public dependency install runs no lifecycle
 *     hooks);
 *  4. the *packaged* `import('jsails').createStarterFiles()` reads its own
 *     bundled templates + `AGENTS.md` (not the repo's source copy) and produces
 *     the full 47-file auth-only starter set (the `--blog` variant adds two
 *     blog pages for 49 files);
 *  5. the fixture's `npm run check` succeeds (typecheck + build, which now
 *     includes the static export), and the exported `out/` artifacts are
 *     validated in place rather than rebuilt;
 *  6. the fixture's `npm run test:report` runs the real server-only native
 *     `node:test` suite (`tsc`, then `node --test` with a spec + JUnit
 *     reporter) against the in-process `jsails/testing` app, with
 *     `JSAILS_BROWSER_PATH` deliberately pointing at a nonexistent binary to
 *     prove the default test path never probes or launches a browser; the
 *     generated cases (home, about, tasks, 404 — counted from the shipped
 *     source, never hardcoded) and the produced `test-results/junit.xml` are
 *     asserted and copied out;
 *  7. a negative proof: a failing `node:test` case is *temporarily appended to
 *     the existing `test/app.test.ts`*, recompiled, and run via
 *     `npm run test:report`; its expected exit 1 plus the JUnit failure, the
 *     recorded expected/actual values, and the source-mapped `test/app.test.ts`
 *     location are asserted and copied out. The original source is then
 *     restored and re-run green, proving the same compiled
 *     `dist/test/app.test.js` is overwritten in place (no stale extra test file);
 *  8. database-gated auth stages (run only when the three MariaDB connection
 *     variables are present): `npm run auth:migrate` creates Better Auth's
 *     tables, `npm run user:create` seeds the account the auth browser journey
 *     signs in with, and that journey runs via `npm run test:browser`; when the
 *     variables are absent each is recorded as an explicit `skipped` with reason
 *     `requires MariaDB (DATABASE_HOST)` — never silently passed;
 *  9. browser stages (run only when `--skip-browser` is *not* passed): the
 *     fixture's `npm run test:browser` passes the generated non-auth Playwright
 *     journeys (soft navigation, the signed server-component add/clear/422
 *     actions, and the in-flight morph), a Playwright negative proof exercises
 *     the failure artifacts, browser QA (hydration, counter, native dialog,
 *     daisyUI styles, content-hashed asset URLs, Turbo soft navigation, the
 *     live server component, and the static read-only fallback, no console
 *     errors) runs against `jsails serve` and a pure static serve of `out/`,
 *     and a real `jsails dev` run proves backend restarts, added routes, and
 *     Vite CSS rebuilds.
 *
 * `--skip-browser` skips every browser stage (test:browser, the browser negative
 * proof, and the serve/static/dev browser QA) and never launches or probes a
 * browser; the pack/install/check/native-test pipeline still runs in full.
 * Database-gated auth stages are still evaluated: with no MariaDB configured
 * they report the explicit database skip reason regardless of `--skip-browser`.
 * Unknown flags are rejected. Without the flag, the complete default pipeline
 * (including all browser stages) runs unchanged.
 *
 * Temporary work lives under /tmp/opencode and is removed on exit; nothing here
 * installs dependencies into the framework workspace. The fixture directory
 * name deliberately contains spaces and a literal `$` to prove no step
 * shell-interpolates project paths. This is opt-in: run it explicitly with
 * `npm run verify:starter` — no CLI command triggers it and it is not part of
 * `npm test`/`npm run check`.
 *
 * A structured summary plus copied evidence is persisted *outside* the temp
 * root, under `test-results/verify-starter/<run-id>/` (git-ignored), so a run
 * stays auditable after its temp fixture is torn down. Only the negative
 * proofs' failure artifacts are captured (a caller-requested local failure
 * artifact); no browser is ever downloaded and no external page is read.
 *
 * Environment:
 *   JSAILS_BROWSER_PATH — override the Chromium/Chrome binary (default
 *                         /usr/bin/chromium). The browser-verification stages
 *                         fail explicitly when no binary is found rather than
 *                         claiming a pass. (The historical `JSIALS_BROWSER_PATH`
 *                         spelling is still honoured as a fallback.)
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEMP_ROOT = join('/tmp/opencode', `jsails-verify-${process.pid}-${Date.now().toString(36)}`);
const PACK_DIR = join(TEMP_ROOT, 'pack');
// Deliberately contains spaces and a literal `$` to prove no path is
// shell-interpolated anywhere in the create/install/serve/dev chain.
const FIXTURE_DIR = join(TEMP_ROOT, 'fixture with space$dollar');
const FIXTURE_NAME = 'jsails-verify-fixture';
/** The framework's own freshly-built CLI (used for `create`). */
const REPO_CLI = join(REPO_ROOT, 'dist', 'src', 'cli.js');
/** The packaged CLI installed into the fixture (used for `serve`/`dev`). */
const INSTALLED_CLI = join(FIXTURE_DIR, 'node_modules', 'jsails', 'dist', 'src', 'cli.js');
const BROWSER_PATH =
  process.env.JSAILS_BROWSER_PATH ?? process.env.JSIALS_BROWSER_PATH ?? '/usr/bin/chromium';

/**
 * Scoped, git-ignored evidence root under the repo (deliberately *outside* the
 * temp root, which is deleted on exit). Each run writes a unique subdir here;
 * no foreign contents are ever deleted.
 */
const EVIDENCE_ROOT = join(REPO_ROOT, 'test-results', 'verify-starter');

/** Bounded budget: npm/network steps get 5 minutes, browser waits 30 seconds. */
const NPM_TIMEOUT_MS = 300_000;
const BROWSER_TIMEOUT_MS = 30_000;
/** Dev toolchain boot (initial tsc + vite build + nodemon + serve) budget. */
const DEV_BOOT_TIMEOUT_MS = 180_000;
/** Budget for a dev backend restart or a Vite asset rebuild. */
const DEV_RESTART_TIMEOUT_MS = 90_000;
/** Grace given to the dev parent so its runtime tears down its children. */
const DEV_STOP_GRACE_MS = 8_000;
/** Budget for leaked dev child processes to exit before being reported. */
const DEV_LEAK_SETTLE_MS = 12_000;
/**
 * Quiet period with no new `Serving at` URL before the latest URL is probed as
 * live. The dev toolchain's tsc-watch initial emit triggers a benign nodemon
 * restart, so the first printed URL can already be dead; this window absorbs
 * that burst before a client is handed the port.
 */
const DEV_QUIESCENCE_MS = 2500;
/** Poll interval for new URLs and for retrying the bounded 2xx liveness probe. */
const DEV_PROBE_INTERVAL_MS = 100;

/**
 * The generated file set `createStarterFiles` must produce for the default
 * (auth-only) variant, order-independent. Derived from `src/app/starter.ts`
 * `BASE_TEMPLATE_FILES` (each template with its `.template` suffix stripped)
 * plus the generated `AGENTS.md`, so it names the full 47-file starter: base
 * pages/components/tests plus the always-shipped auth and CLI-command files.
 * The `--admin` variant swaps only the app config (still 47 files); the
 * `--blog` variant adds the two `pages/blog/*.tsx` pages (49 files). The
 * `--cli` variant is a separate shape (7 files from `templates/starter-cli/`,
 * including a real `jsails.app.js` with `plugins.use: []`) and the `--static`
 * variant is a separate SSG shape (15 files from `templates/starter-static/`,
 * with `plugins.use: []` and no auth/API/server-components/Jamal); neither is
 * part of this web-starter verification. Their file sets and build/run smoke
 * are asserted in the unit/subprocess test suites instead.
 */
const EXPECTED_KEYS = [
  '.env.auth.example',
  '.gitignore',
  'AGENTS.md',
  'api/me.ts',
  'app/application-auth.ts',
  'app/application-client.ts',
  'app/application-command.ts',
  'app/application-component.ts',
  'app/application-job.ts',
  'app/application-plugin.ts',
  'app/application-record.ts',
  'app/application-resource.ts',
  'app/application-testing.ts',
  'app/registry.ts',
  'auth/README.md',
  'client/main.tsx',
  'commands/login.ts',
  'commands/logout.ts',
  'commands/whoami.ts',
  'components/task-list.tsx',
  'jamal.config.js',
  'jsails.app.js',
  'jsails.config.js',
  'package.json',
  'pages/about.tsx',
  'pages/dashboard.tsx',
  'pages/device.tsx',
  'pages/index.tsx',
  'pages/login.tsx',
  'pages/tasks.tsx',
  'playwright.config.ts',
  'scripts/auth-migrate.mjs',
  'scripts/create-user.mjs',
  'scripts/db-migrate.mjs',
  'scripts/run-tests.mjs',
  'test/app.test.ts',
  'test/auth.test.ts',
  'test/browser/auth.spec.ts',
  'test/browser/fixtures.ts',
  'test/browser/home.spec.ts',
  'tsconfig.client.json',
  'tsconfig.json',
  'ui/components.tsx',
  'ui/counter.tsx',
  'ui/layout.tsx',
  'ui/styles.css',
  'vite.config.js',
].sort();

/**
 * The three MariaDB connection variables that gate every database-backed auth
 * stage. Starter auth is lazy: importing the app config performs no database
 * work, so build, static export, and the native suite run without a database —
 * but `auth:migrate`, `user:create`, and the auth browser journey genuinely
 * need a live MariaDB. When these are unset those stages are recorded as
 * explicit skips (never silently passed).
 */
const REQUIRED_DB_VARS = ['DATABASE_HOST', 'DATABASE_NAME', 'DATABASE_USER'];

/** Skip detail used verbatim for every stage that needs a live MariaDB. */
const DATABASE_SKIP_REASON = 'requires MariaDB (DATABASE_HOST)';

/** The database variables absent from the current environment (empty values count). */
const missingDbVars = REQUIRED_DB_VARS.filter((name) => {
  const value = process.env[name];
  return value === undefined || value === '';
});

/** Whether every required database variable is present in the environment. */
const hasDatabase = missingDbVars.length === 0;

/**
 * Deterministic Better Auth signing secret for the verification fixture. A
 * caller-supplied `BETTER_AUTH_SECRET` is honored; otherwise a fixed >= 32-byte
 * value keeps the migrate/create/serve/browser chain consistent within a run.
 */
const BETTER_AUTH_SECRET_VALUE =
  process.env.BETTER_AUTH_SECRET ?? 'jsails-verify-starter-secret-0123456789abcdef';

/**
 * The seeded account for the auth browser journey. A unique email per run avoids
 * colliding with an account a previous run created; a caller-supplied
 * `AUTH_TEST_EMAIL`/`AUTH_TEST_PASSWORD` is honored so the journey can target an
 * existing account.
 */
const AUTH_TEST_EMAIL =
  process.env.AUTH_TEST_EMAIL ?? `verify-${Date.now().toString(36)}@example.com`;
const AUTH_TEST_PASSWORD = process.env.AUTH_TEST_PASSWORD ?? 'verify-starter-password';

/**
 * The two generated browser suites, split by database need. The non-auth suite
 * runs without a database; the auth journey is gated on a live MariaDB and the
 * seeded account above.
 */
const BROWSER_NON_AUTH_SPEC = 'test/browser/home.spec.ts';
const BROWSER_AUTH_SPEC = 'test/browser/auth.spec.ts';

/** Matches each `Serving at http://127.0.0.1:<port>/` the dev toolchain prints. */
const SERVE_URL_PATTERN = /Serving at (https?:\/\/\S+)/g;

/**
 * Lazily load the compiled readiness helper. It lives under `src/dev/` and is
 * only available once the `build-root` stage has run `npm run build`, so the
 * import is deferred to the first `dev-server` stage call — never executed at
 * module load, before the build has produced `dist/src/dev/readiness.js`.
 */
let readinessModulePromise = null;
function getReadinessModule() {
  if (readinessModulePromise === null) {
    readinessModulePromise = import(new URL('../dist/src/dev/readiness.js', import.meta.url).href);
  }
  return readinessModulePromise;
}

/**
 * The two fixed starter assets must be emitted as root-relative URLs carrying a
 * content-derived SHA-256 query (`?v=<64 hex chars>`). The hash itself is
 * content-dependent, so it is matched by shape, never by a literal value.
 */
const HASHED_CSS_ASSET = /^\/assets\/app\.css\?v=[0-9a-f]{64}$/;
const HASHED_JS_ASSET = /^\/assets\/app\.js\?v=[0-9a-f]{64}$/;

/** Path (relative to the fixture) of the temporary failing spec written at runtime. */
const NEGATIVE_SPEC_REL = 'test/browser/verify-failure.spec.ts';

/** Sentinel query token the failing spec sends so sanitization can be proven. */
const NEGATIVE_TOKEN = 'fake-secret';
/** Sentinel console text the failing spec emits so capture can be proven. */
const NEGATIVE_CONSOLE_MARKER = 'benign-proof-console-error';
/** The route path the failing spec aborts, carrying the sentinel token. */
const NEGATIVE_ROUTE = '/proof-ping';

/** The starter source file the native negative proof appends to and restores. */
const NATIVE_APP_TEST_REL = 'test/app.test.ts';
/** Sentinel message the appended failing `node:test` case asserts with. */
const NATIVE_FAILURE_MARKER = 'JSAILS_INTENTIONAL_NODE_FAILURE';
/** The two values whose recorded presence proves the JUnit diff was captured. */
const NATIVE_FAILURE_ACTUAL = 'ACTUAL_TEST_VALUE';
const NATIVE_FAILURE_EXPECTED = 'EXPECTED_TEST_VALUE';
/**
 * The appended failing case. It compiles into the *same* `dist/test/app.test.js`
 * as the shipped cases (never a separate file), and uses the `assert`/`test`
 * bindings the starter's `test/app.test.ts` already imports.
 */
const NATIVE_FAILURE_SOURCE = `

test('intentional node failure proof (expected to fail)', () => {
  assert.equal('${NATIVE_FAILURE_ACTUAL}', '${NATIVE_FAILURE_EXPECTED}', '${NATIVE_FAILURE_MARKER}');
});
`;

const log = (line) => process.stdout.write(`[verify:starter] ${line}\n`);

const tail = (text, max = 4000) => (text.length > max ? text.slice(-max) : text);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse `verify:starter` arguments. Only `--skip-browser` is recognized; any
 * other flag or positional argument is rejected so a typo cannot silently
 * change the verification scope.
 */
function parseFlags(argv) {
  let skipBrowser = false;
  for (const arg of argv) {
    if (arg === '--skip-browser') {
      skipBrowser = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown flag: ${arg} (only --skip-browser is accepted)`);
    } else {
      throw new Error(`unexpected argument: ${arg} (only --skip-browser is accepted)`);
    }
  }
  return skipBrowser;
}

/** Spawn a command, resolve with `{ code, signal, stdout, stderr }` regardless of exit. */
function runCommandResult(cmd, args, { cwd, env, timeoutMs = NPM_TIMEOUT_MS, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env === undefined ? process.env : { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${label}: failed to spawn: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${label}: timed out after ${timeoutMs} ms`));
        return;
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/** Spawn a command, resolve on exit 0, reject otherwise. */
async function runCommand(cmd, args, opts) {
  const { code, signal, stdout, stderr } = await runCommandResult(cmd, args, opts);
  if (code !== 0) {
    throw new Error(
      `${opts.label}: exit ${code}${signal ? ` (signal ${signal})` : ''}\n` +
        `--- stdout (tail) ---\n${tail(stdout)}\n--- stderr (tail) ---\n${tail(stderr)}`,
    );
  }
  return { stdout, stderr };
}

/** Reserve and release a loopback TCP port, returning the free port number. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Resolve the fixture's own `@playwright/test` CLI entry (never `npx`, never the
 * PATH), so the tests run with the installed devDependency.
 */
function resolvePlaywrightCli() {
  const pkgPath = join(FIXTURE_DIR, 'node_modules', '@playwright', 'test', 'package.json');
  if (!existsSync(pkgPath)) {
    throw new Error(
      'the fixture is missing @playwright/test; did create --install skip devDependencies?',
    );
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.playwright;
  if (typeof bin !== 'string' || bin.length === 0) {
    throw new Error('the installed @playwright/test declares no "playwright" bin');
  }
  return join(dirname(pkgPath), bin);
}

/** Resolve a reporter attachment path (absolute, or relative to the fixture). */
function resolveAttachmentPath(path) {
  if (typeof path !== 'string' || path.length === 0) return null;
  return isAbsolute(path) ? path : join(FIXTURE_DIR, path);
}

/** Flatten every test result from a Playwright JSON report into a simple shape. */
function collectTestResults(report) {
  const results = [];
  for (const suite of report.suites ?? []) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          results.push({
            specFile: spec.file,
            specLine: spec.line,
            specTitle: spec.title,
            testTitle: test.title,
            status: result.status,
            errors: result.errors ?? [],
            attachments: result.attachments ?? [],
          });
        }
      }
    }
  }
  return results;
}

/** Recursively collect compiled `*.test.js` files under `dir` (fixture-relative). */
function collectCompiledTestFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectCompiledTestFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.test.js'))
      files.push(relative(FIXTURE_DIR, full));
  }
  return files.sort();
}

/** Recursively collect generated `*.spec.ts` files under `dir` (absolute paths). */
function collectSpecFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectSpecFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.spec.ts')) files.push(full);
  }
  return files.sort();
}

/**
 * Count top-level `test(` declarations across source files. Both the native
 * `node:test` suite and the Playwright spec indent every `test.step(...)`, so a
 * line-anchored `^test\(` counts only the cases that become real test results —
 * never a step, a string, or a comment. Deriving the expected count here (rather
 * than hardcoding it) keeps the harness honest as shipped cases are added.
 */
function countDeclaredTests(filePaths) {
  let total = 0;
  for (const filePath of filePaths) {
    total += (readFileSync(filePath, 'utf8').match(/^test\(/gm) ?? []).length;
  }
  return total;
}

/** Long-running children owned by this script, torn down on exit. */
const owned = new Set();

/** Spawn a server, resolve once `match` appears in stdout with the captured URL. */
function spawnServer({ cmd, args, cwd, env, match, timeoutMs = 30_000, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env === undefined ? process.env : { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    owned.add(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(
        new Error(
          `${label}: timed out waiting for listen output (${timeoutMs} ms); ` +
            `stdout=${JSON.stringify(stdout.slice(-500))} stderr=${JSON.stringify(stderr.slice(-500))}`,
        ),
      );
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const found = stdout.match(match);
      if (found && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ url: found[1], stop: () => stopChild(child) });
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${label}: failed to spawn: ${error.message}`));
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `${label}: exited before listening (code=${code} signal=${signal}); ` +
            `stdout=${JSON.stringify(stdout.slice(-500))} stderr=${JSON.stringify(stderr.slice(-500))}`,
        ),
      );
    });
  });
}

/**
 * Spawn the dev toolchain and capture every `Serving at` URL it prints. Resolves
 * with a handle only once the *latest* URL has been confirmed live: the port
 * changes on every nodemon restart because the app is driven with `PORT=0`, and
 * the tsc-watch initial emit triggers a benign restart whose first URL is already
 * dead by the time a client connects. `waitForUrl()` resolves with each subsequent
 * restart's live URL, and `stop()` tears the parent down with a bounded
 * SIGTERM/SIGKILL grace so its runtime can dispose of its own child groups.
 */
async function spawnDevServer({ cmd, args, cwd, env, timeoutMs = DEV_BOOT_TIMEOUT_MS, label }) {
  const { DevUrlTracker } = await getReadinessModule();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env === undefined ? process.env : { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    owned.add(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let exited = null;
    let seenUrls = 0;

    const tracker = new DevUrlTracker({
      quiescenceMs: DEV_QUIESCENCE_MS,
      pollIntervalMs: DEV_PROBE_INTERVAL_MS,
    });

    const abort = () => exited !== null;

    const waitForUrl = (waitTimeoutMs = DEV_RESTART_TIMEOUT_MS) =>
      tracker.waitForLive({ timeoutMs: waitTimeoutMs, aborted: abort }).then((live) => live.url);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const found = [...stdout.matchAll(SERVE_URL_PATTERN)];
      while (seenUrls < found.length) {
        tracker.noteUrl(found[seenUrls][1]);
        seenUrls += 1;
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label}: failed to spawn: ${error.message}`));
    });
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `${label}: exited before a live Serving URL was confirmed (code=${code} signal=${signal}); ` +
            `stdout=${JSON.stringify(stdout.slice(-800))} stderr=${JSON.stringify(stderr.slice(-800))}`,
        ),
      );
    });

    tracker.waitForLive({ timeoutMs, aborted: abort }).then(
      (live) => {
        if (settled) return;
        settled = true;
        resolve({
          firstUrl: live.url,
          waitForUrl,
          pid: child.pid,
          stop: () => stopChild(child, DEV_STOP_GRACE_MS),
        });
      },
      (error) => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(
          new Error(
            `${label}: ${error.message}; ` +
              `stdout=${JSON.stringify(stdout.slice(-800))} stderr=${JSON.stringify(stderr.slice(-800))}`,
          ),
        );
      },
    );
  });
}

/** SIGTERM a child, escalating to SIGKILL after a grace period. */
function stopChild(child, graceMs = 3000) {
  owned.delete(child);
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const killTimer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    killTimer.unref();
    child.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

/** The single Chromium instance reused across browser stages. */
let browser = null;

/** Number of times a Chromium instance was actually launched this run. */
let browserLaunches = 0;

/** Launch Chromium once with the default sandbox; error clearly when absent. */
async function getBrowser() {
  if (!existsSync(BROWSER_PATH)) {
    throw new Error(
      `Chromium binary not found at "${BROWSER_PATH}". ` +
        `Set JSAILS_BROWSER_PATH to a Chromium/Chrome executable to run browser QA; ` +
        `browser verification cannot be claimed as passing without it.`,
    );
  }
  if (browser === null) {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ executablePath: BROWSER_PATH });
    browserLaunches += 1;
  }
  return browser;
}

/** A color is transparent only when it carries a zero alpha channel. */
function isTransparent(color) {
  if (typeof color !== 'string') return false;
  if (color === 'transparent') return true;
  // legacy comma syntax with a zero alpha in the 4th slot (rgba/hsla only).
  if (/^(?:rgba|hsla)\([^)]*,\s*0(?:\.0+)?\s*\)\s*$/i.test(color)) return true;
  // modern syntax with a trailing "/ 0" alpha (oklch, oklab, color, lab, lch).
  if (/\/\s*0(?:\.0+)?\s*\)\s*$/i.test(color)) return true;
  return false;
}

/** Route the benign /favicon.ico request so it never emits a console error. */
async function openQaPage() {
  const b = await getBrowser();
  const page = await b.newPage();
  await page.route('**/favicon.ico', (route) =>
    route.fulfill({ status: 200, contentType: 'image/x-icon', body: '' }),
  );
  page.setDefaultTimeout(BROWSER_TIMEOUT_MS);
  return page;
}

/**
 * Drive one full browser pass against `url`: hydration, counter, native dialog,
 * asset status, daisyUI styles, and a clean console. Returns observed facts.
 */
async function runBrowserQa(url) {
  const page = await openQaPage();
  const errors = [];
  try {
    // The starter ships no favicon; the route above fulfils Chromium's automatic
    // /favicon.ico request so the "no console errors" check reports only real
    // application failures.
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('#counter-root[data-hydrated="true"]');

    const counts = [];
    counts.push((await page.textContent('[data-counter-value]'))?.trim());
    await page.click('[data-counter-increment]');
    counts.push((await page.textContent('[data-counter-value]'))?.trim());
    await page.click('[data-counter-increment]');
    counts.push((await page.textContent('[data-counter-value]'))?.trim());

    // Native <dialog>: open, Esc closes and focus returns to the trigger, then
    // the close button works on a fresh open.
    await page.click('[data-open-dialog]');
    await page.waitForFunction(() => document.querySelector('dialog')?.open === true);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('dialog')?.open === false);
    const focusReturned = await page.evaluate(() =>
      document.activeElement?.matches('[data-open-dialog]'),
    );
    await page.click('[data-open-dialog]');
    await page.waitForFunction(() => document.querySelector('dialog')?.open === true);
    await page.click('[data-close-dialog]');
    await page.waitForFunction(() => document.querySelector('dialog')?.open === false);

    const styles = await page.evaluate(() => {
      const button = document.querySelector('[data-counter-increment]');
      const computed = getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      return {
        backgroundColor: computed.backgroundColor,
        height: rect.height,
        width: rect.width,
        display: computed.display,
        visibility: computed.visibility,
      };
    });

    if (JSON.stringify(counts) !== JSON.stringify(['0', '1', '2'])) {
      throw new Error(`counter did not advance 0 -> 1 -> 2 (observed ${JSON.stringify(counts)})`);
    }
    if (focusReturned !== true) {
      throw new Error('focus did not return to the open-dialog trigger after Escape');
    }
    if (styles.visibility !== 'visible' || styles.display === 'none') {
      throw new Error('counter button is not visible');
    }
    if (styles.height < 38 || styles.width < 60) {
      throw new Error(
        `counter button dimensions not daisyUI-styled: ` +
          `${styles.width.toFixed(1)}x${styles.height.toFixed(1)}px`,
      );
    }
    if (isTransparent(styles.backgroundColor)) {
      throw new Error(`counter button background is transparent (daisyUI not applied)`);
    }

    // The two fixed assets must be emitted as content-hashed root-relative URLs
    // (the hash is matched by shape, not literal value), and each resolved asset
    // must serve 200 with the right content type. Reading the actual `href`/`src`
    // from the document (never a hardcoded path) proves the resolver ran.
    const assetRefs = await page.evaluate(() => {
      const link = document.querySelector('link[rel="stylesheet"]');
      const script = document.querySelector('script[type="module"]');
      return {
        css: link === null ? null : link.getAttribute('href'),
        js: script === null ? null : script.getAttribute('src'),
      };
    });
    if (assetRefs.css === null || !HASHED_CSS_ASSET.test(assetRefs.css)) {
      throw new Error(
        `stylesheet href ${JSON.stringify(assetRefs.css)} is not a content-hashed /assets/app.css?v=<sha256> URL`,
      );
    }
    if (assetRefs.js === null || !HASHED_JS_ASSET.test(assetRefs.js)) {
      throw new Error(
        `module script src ${JSON.stringify(assetRefs.js)} is not a content-hashed /assets/app.js?v=<sha256> URL`,
      );
    }
    const assets = await Promise.all(
      [assetRefs.css, assetRefs.js].map(async (path) => {
        const response = await fetch(new URL(path, url));
        return {
          path,
          status: response.status,
          contentType: response.headers.get('content-type') ?? '',
        };
      }),
    );
    for (const asset of assets) {
      if (asset.status !== 200) {
        throw new Error(`${asset.path} returned HTTP ${asset.status}, expected 200`);
      }
    }
    const cssAsset = assets.find((asset) => asset.path === assetRefs.css);
    if (!cssAsset.contentType.toLowerCase().startsWith('text/css')) {
      throw new Error(
        `${assetRefs.css} served with content-type ${JSON.stringify(cssAsset.contentType)}, expected text/css`,
      );
    }

    if (errors.length > 0) {
      throw new Error(`browser console/page errors:\n${errors.join('\n')}`);
    }

    return { counts, focusReturned, styles, assets };
  } finally {
    await page.close();
  }
}

/** Navigate a fresh page to `url` and assert `selector` renders `expectedText`. */
async function assertElementText(url, selector, expectedText) {
  const page = await openQaPage();
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector(selector);
    const text = (await page.textContent(selector))?.trim();
    if (text !== expectedText) {
      throw new Error(
        `expected ${selector} text ${JSON.stringify(expectedText)}, got ${JSON.stringify(text)} at ${url}`,
      );
    }
  } finally {
    await page.close();
  }
}

/**
 * Drive one navigation pass: a Turbo soft navigation from the home page to
 * `/about` swaps only the document body, so a window-scoped marker stashed
 * before the click survives. A full reload replaces the document and drops it.
 * Returns observed facts.
 */
async function runNavigationQa(url) {
  const page = await openQaPage();
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('#counter-root[data-hydrated="true"]');
    await page.evaluate(() => {
      globalThis.__jsailsVerifySentinel = 'alive';
    });
    await page.locator('nav a[href="/about"]').click();
    await page.waitForURL(/\/about\/?$/);
    await page.waitForSelector('h1');
    const heading = (await page.textContent('h1'))?.trim();
    const sentinel = await page.evaluate(() => globalThis.__jsailsVerifySentinel);
    if (heading !== 'About') {
      throw new Error(`expected About heading after navigation, got ${JSON.stringify(heading)}`);
    }
    if (sentinel !== 'alive') {
      throw new Error(
        'window marker did not survive the About navigation (a full reload occurred)',
      );
    }
    return { heading, sentinel };
  } finally {
    await page.close();
  }
}

/**
 * Drive the live server component on `/tasks` under a served app: the signed
 * snapshot renders the interactive form (never the static fallback), adding a
 * task updates the list and clears the input, and a blank title returns a
 * validation error without adding an item. Returns observed facts.
 */
async function runServerComponentQa(url) {
  const page = await openQaPage();
  try {
    await page.goto(new URL('/tasks', url).href, { waitUntil: 'load' });
    await page.waitForSelector('[data-jsails-component="task-list"][data-hydrated="true"]');

    await page.locator('[data-task-input]').fill('First task');
    await page.locator('[data-task-submit]').click();
    await page.waitForSelector('[data-task-item]');
    const items = (await page.locator('[data-task-item]').allTextContents()).map((text) =>
      text.trim(),
    );
    if (JSON.stringify(items) !== JSON.stringify(['First task'])) {
      throw new Error(`expected a single "First task" item, got ${JSON.stringify(items)}`);
    }
    const cleared = await page.locator('[data-task-input]').inputValue();
    if (cleared !== '') {
      throw new Error(`expected the task input to clear after add, got ${JSON.stringify(cleared)}`);
    }

    await page.locator('[data-task-input]').fill('   ');
    await page.locator('[data-task-submit]').click();
    await page.waitForSelector('[data-task-error]');
    const itemCountAfterError = await page.locator('[data-task-item]').count();
    if (itemCountAfterError !== 1) {
      throw new Error(`blank title added an item (count ${itemCountAfterError}, expected 1)`);
    }

    return { items: items.length, errorShown: true };
  } finally {
    await page.close();
  }
}

/**
 * Drive the static-exported `/tasks` page served from `out/`: the read-only
 * fallback renders (no signed snapshot, CSRF, component root id, or interactive
 * form), and the local counter island — mounted outside the component boundary —
 * still hydrates and works. Returns observed facts.
 */
async function runStaticTasksQa(url) {
  const page = await openQaPage();
  try {
    await page.goto(new URL('/tasks', url).href, { waitUntil: 'load' });
    await page.waitForSelector('#counter-root[data-hydrated="true"]');

    const body = (await page.locator('body').textContent()) ?? '';
    // JSX renders the notice across source lines; collapse whitespace so the
    // check is not sensitive to the template's wrapping.
    if (!body.replace(/\s+/g, ' ').includes('not available in the static export')) {
      throw new Error('static tasks page does not render the read-only fallback notice');
    }
    // The static fallback is wrapped in a `[data-jsails-component]` root (the
    // client still needs to locate the component boundary), so that marker is
    // expected. Only the *interactive* mount markers — a signed snapshot, CSRF,
    // a generated component id, and the input/submit form — must be absent.
    const liveMarkers = await page.evaluate(() => ({
      snapshot: document.querySelector('[data-jsails-component-snapshot]') !== null,
      csrf: document.querySelector('[data-jsails-component-csrf]') !== null,
      rootId: document.querySelector('[id^="jsails-component-"]') !== null,
      input: document.querySelector('[data-task-input]') !== null,
      submit: document.querySelector('[data-task-submit]') !== null,
    }));
    for (const [name, present] of Object.entries(liveMarkers)) {
      if (present) {
        throw new Error(`static tasks page unexpectedly carries a live ${name} marker`);
      }
    }

    // The counter island sits outside the component boundary, so it still works.
    await page.locator('[data-counter-increment]').click();
    const count = (await page.textContent('[data-counter-value]'))?.trim();
    if (count !== '1') {
      throw new Error(
        `static tasks counter did not advance to 1 (observed ${JSON.stringify(count)})`,
      );
    }

    return { counter: count };
  } finally {
    await page.close();
  }
}

/** Poll a file until it contains `needle`, bounded by `timeoutMs`. */
async function waitForFileToContain(filePath, needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let content = '';
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      // The Vite rebuild momentarily empties/replaces the file; keep waiting.
    }
    if (content.includes(needle)) return;
    await sleep(250);
  }
  throw new Error(
    `timed out after ${timeoutMs} ms waiting for ${filePath} to contain ${JSON.stringify(needle)}`,
  );
}

/**
 * Read `{ pid, ppid, starttime }` from `/proc/<pid>/stat`, or `null` when the
 * entry is unreadable or already gone. Only process *metadata* is read here —
 * never `/proc/<pid>/environ` — so unrelated processes' environment is never
 * touched. `starttime` (in clock ticks) is the identity guard used to avoid
 * killing a PID that the kernel has since recycled for an unrelated process.
 */
function readProcStat(pid) {
  try {
    const stat = readFileSync(join('/proc', String(pid), 'stat'), 'utf8');
    const close = stat.lastIndexOf(')');
    if (close === -1) return null;
    // After "pid (comm) ", fields[0]=state, fields[1]=ppid, fields[19]=starttime.
    const fields = stat
      .slice(close + 2)
      .trim()
      .split(/\s+/);
    return { pid, ppid: Number(fields[1]), starttime: Number(fields[19]) };
  } catch {
    return null;
  }
}

/**
 * Snapshot the process tree rooted at `rootPids` — the roots plus every known
 * descendant — using only /proc metadata (ppid). Returns a `Map<pid, info>` of
 * the captured members, or an empty map when /proc is unavailable (the leak
 * check is then explicitly limited, never a global claim).
 */
function snapshotProcessTree(rootPids) {
  let names;
  try {
    names = readdirSync('/proc');
  } catch {
    return new Map();
  }
  const table = new Map();
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const info = readProcStat(pid);
    if (info !== null) table.set(pid, info);
  }
  const members = new Map();
  const queue = [...rootPids];
  while (queue.length > 0) {
    const pid = queue.pop();
    if (members.has(pid)) continue;
    const info = table.get(pid);
    if (info === undefined) continue;
    members.set(pid, info);
    for (const [childPid, childInfo] of table) {
      if (childInfo.ppid === pid && !members.has(childPid)) queue.push(childPid);
    }
  }
  return members;
}

/** Members of `snapshot` still alive under the *same* starttime. */
function liveSnapshotMembers(snapshot) {
  const alive = [];
  for (const { pid, starttime } of snapshot.values()) {
    const info = readProcStat(pid);
    if (info !== null && info.starttime === starttime) alive.push({ pid, starttime });
  }
  return alive;
}

/** Wait up to `timeoutMs` for captured processes to exit; return stragglers. */
async function settleProcessTree(snapshot, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let leaked = liveSnapshotMembers(snapshot);
  while (leaked.length > 0 && Date.now() < deadline) {
    await sleep(250);
    leaked = liveSnapshotMembers(snapshot);
  }
  return leaked;
}

/**
 * SIGKILL stragglers that still carry their captured starttime (guarding
 * against PID reuse). Only PIDs captured as our own descendants are ever
 * signalled; no unrelated process is read from or killed.
 */
function killLeakedProcesses(leaked) {
  const killed = [];
  for (const { pid, starttime } of leaked) {
    const info = readProcStat(pid);
    if (info === null || info.starttime !== starttime) continue; // PID recycled.
    try {
      process.kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch {
      // Already exited between the check and the kill.
    }
  }
  return killed;
}

/** Read the version of an installed package under a node_modules directory. */
function installedVersion(dir, name) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8'));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/** Best-effort capture of tool versions for the final report. */
function collectVersions(skipBrowser) {
  const read = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  };
  return {
    node: process.version,
    npm: read('npm', ['--version']),
    jsails: (() => {
      try {
        return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;
      } catch {
        return null;
      }
    })(),
    // Under --skip-browser the Chromium binary is never probed (not even
    // `--version`), so the run performs zero browser subprocess activity.
    chromium: skipBrowser
      ? null
      : existsSync(BROWSER_PATH)
        ? read(BROWSER_PATH, ['--version'])
        : null,
    preact: installedVersion(FIXTURE_DIR, 'preact'),
    '@preact/signals': installedVersion(FIXTURE_DIR, '@preact/signals'),
    vite: installedVersion(FIXTURE_DIR, 'vite'),
    hono: installedVersion(FIXTURE_DIR, 'hono'),
    '@hono/node-server': installedVersion(FIXTURE_DIR, '@hono/node-server'),
    typescript: installedVersion(FIXTURE_DIR, 'typescript'),
    tailwindcss: installedVersion(FIXTURE_DIR, 'tailwindcss'),
    daisyui: installedVersion(FIXTURE_DIR, 'daisyui'),
  };
}

/**
 * Insert a dev marker element just before the page's closing `</Layout>` tag.
 * The starter home page renders its content inside the shared `ui/layout.tsx`
 * shell (`<Layout>…</Layout>`), so there is no literal `</body>` to anchor on;
 * the marker is injected as the last child of that shell instead.
 */
function addDevMarkerToIndex(marker) {
  const indexPath = join(FIXTURE_DIR, 'pages', 'index.tsx');
  const content = readFileSync(indexPath, 'utf8');
  if (content.includes('<div id="dev-marker">')) {
    throw new Error('pages/index.tsx already carries a dev marker; the fixture is not clean');
  }
  const replaced = content.replace(
    '</Layout>',
    `      <div id="dev-marker">${marker}</div>\n    </Layout>`,
  );
  if (replaced === content) {
    throw new Error('could not locate </Layout> in pages/index.tsx');
  }
  writeFileSync(indexPath, replaced);
}

/** A minimal second page compiled by `tsc --watch` and served as `/added`. */
const ADDED_PAGE_SOURCE = `export default function AddedPage() {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Added Route</title>
      </head>
      <body>
        <h1 id="added-route-marker">added-route-ok</h1>
      </body>
    </html>
  );
}
`;

/** Append a custom-property rule to the stylesheet for the Vite rebuild check. */
function appendCustomProperty(propName, value) {
  const stylesPath = join(FIXTURE_DIR, 'ui', 'styles.css');
  writeFileSync(
    stylesPath,
    `${readFileSync(stylesPath, 'utf8')}\n:root {\n  ${propName}: ${value};\n}\n`,
  );
}

/**
 * The temporary failing spec for the negative proof. It imports the *real*
 * fixtures (`test`, `expect`, `gotoHydrated`), aborts a controlled request whose
 * query string carries a sentinel token, emits a benign console error, and then
 * fails an assertion against the counter (expected 999, actual 0). The abort is
 * deliberate: it exercises the diagnostics collector's failed-request capture
 * without depending on any network.
 */
const NEGATIVE_SPEC_SOURCE = `/**
 * Intentional-failure proof, written at runtime by the verify-starter harness
 * and removed before the green re-run. Never part of the shipped starter.
 */

import { expect, gotoHydrated, test } from './fixtures.js';

test('intentional failure proof (expected to fail)', async ({ page }) => {
  // A controlled request that is aborted, carrying a sentinel token in its
  // query string so the diagnostics collector can prove query strings are
  // stripped from recorded URLs.
  await page.route(/\\/proof-ping\\?/, (route) => route.abort('failed'));

  await gotoHydrated(page);

  // A benign console error the diagnostics collector must capture.
  await page.evaluate(() => {
    console.error('${NEGATIVE_CONSOLE_MARKER}');
  });

  // Trigger the aborted request; the abort rejects the fetch by design.
  await page.evaluate(async () => {
    try {
      await fetch('${NEGATIVE_ROUTE}?__proof_token=${NEGATIVE_TOKEN}');
    } catch {
      // Expected: the route above aborts this request.
    }
  });

  // The assertion that must fail: the counter starts at 0, not 999.
  await expect(page.locator('[data-counter-value]')).toHaveText('999');
});
`;

/**
 * Exercise the live dev toolchain: initial smoke, an edited page picked up after
 * a backend restart, a newly added route, and a CSS custom property rebuilt by
 * Vite and asserted after an explicit reload. Returns a human-readable summary.
 */
async function exerciseDevServer(dev) {
  const facts = [];

  // 1. Initial smoke against the first Serving URL (same port serves assets).
  const initial = await runBrowserQa(dev.firstUrl);
  facts.push(`initial smoke at ${dev.firstUrl} (bg ${initial.styles.backgroundColor})`);

  // 2. Edit the owned pages/index.tsx and wait for the backend restart.
  const marker = `DEV_MARKER_${Date.now().toString(36)}`;
  addDevMarkerToIndex(marker);
  const afterIndexEdit = await dev.waitForUrl();
  facts.push(`restarted at ${afterIndexEdit} after pages/index.tsx edit`);
  await assertElementText(afterIndexEdit, '#dev-marker', marker);

  // 3. Add a new pages/added.tsx route; it is compiled and served automatically.
  writeFileSync(join(FIXTURE_DIR, 'pages', 'added.tsx'), ADDED_PAGE_SOURCE);
  const afterAddedRoute = await dev.waitForUrl();
  facts.push(`restarted at ${afterAddedRoute} after pages/added.tsx`);
  await assertElementText(
    new URL('/added', afterAddedRoute).href,
    '#added-route-marker',
    'added-route-ok',
  );

  // 4. Edit ui/styles.css: wait for Vite to rebuild app.css, then reload the
  //    browser explicitly and assert the computed custom property. The value is
  //    an identifier token, not a number: lightningcss (Vite's CSS minifier)
  //    re-serializes bare integers with float32 precision (e.g. 8675309 becomes
  //    8675310), which would make the assertion depend on minifier internals.
  const cssProp = '--jsails-verify-marker';
  const cssValue = 'jsails-verify-marker-ok';
  const appCss = join(FIXTURE_DIR, 'public', 'assets', 'app.css');
  const page = await openQaPage();
  try {
    await page.goto(afterAddedRoute, { waitUntil: 'load' });
    appendCustomProperty(cssProp, cssValue);
    await waitForFileToContain(appCss, cssProp, DEV_RESTART_TIMEOUT_MS);
    await page.reload({ waitUntil: 'load' });
    const value = await page.evaluate((name) => {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }, cssProp);
    if (value !== cssValue) {
      throw new Error(
        `expected custom property ${cssProp} = ${JSON.stringify(cssValue)}, got ${JSON.stringify(value)} after reload`,
      );
    }
    facts.push(`ui/styles.css custom property rebuilt by Vite and asserted after reload`);
  } finally {
    await page.close();
  }

  return facts.join('; ');
}

/**
 * Evidence persistence: a scoped, git-ignored run directory *outside* the temp
 * root, holding a structured summary and copies of the failure artifacts. Only
 * the current run's unique subdir is created; foreign contents are never deleted.
 */
let evidence = null;

/** Create a unique, non-destructive run directory under the evidence root. */
function initEvidence() {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const runDir = join(EVIDENCE_ROOT, runId);
  mkdirSync(join(runDir, 'artifacts'), { recursive: true });
  evidence = {
    runId,
    runDir,
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    artifacts: [],
  };
  return evidence;
}

/** Copy an evidence file into the run dir and record its relative path. */
function copyEvidenceArtifact(srcPath, destName, description) {
  if (!existsSync(srcPath)) {
    throw new Error(`evidence artifact missing at ${srcPath}`);
  }
  const destPath = join(evidence.runDir, 'artifacts', destName);
  copyFileSync(srcPath, destPath);
  const relativePath = relative(evidence.runDir, destPath);
  evidence.artifacts.push({ name: destName, relativePath, description });
  return destPath;
}

/**
 * The negative proof: write a temporary failing spec, run *only* it with tracing
 * explicitly enabled, assert the expected exit 1 and every recorded failure
 * artifact (source file/line, expected vs actual, screenshot, sanitized
 * diagnostics, trace), copy that evidence out, then remove the spec and re-run
 * the original tests green without rebuilding. Throws on any deviation from the
 * expected failure, so the proof can never falsely pass.
 */
async function runNegativeProof() {
  const cli = resolvePlaywrightCli();
  const port = await findFreePort();
  const specPath = join(FIXTURE_DIR, NEGATIVE_SPEC_REL);
  const reportPath = join(FIXTURE_DIR, 'test-results', 'results.json');
  writeFileSync(specPath, NEGATIVE_SPEC_SOURCE);
  try {
    const failRun = await runCommandResult(process.execPath, [cli, 'test', NEGATIVE_SPEC_REL], {
      cwd: FIXTURE_DIR,
      env: {
        JSAILS_BROWSER_PATH: BROWSER_PATH,
        JSAILS_TEST_PORT: String(port),
        JSAILS_TRACE: '1',
      },
      timeoutMs: NPM_TIMEOUT_MS,
      label: 'playwright test (intentional failure, trace on)',
    });
    if (failRun.code !== 1) {
      throw new Error(
        `expected the failing spec to exit 1, got ${failRun.code}\n` +
          `--- stdout (tail) ---\n${tail(failRun.stdout)}\n--- stderr (tail) ---\n${tail(failRun.stderr)}`,
      );
    }

    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const collected = collectTestResults(report);
    const failed = collected.filter((r) => r.status === 'failed');
    if (failed.length !== 1) {
      throw new Error(`expected exactly one failed result, got ${failed.length}`);
    }
    const result = failed[0];

    // The JSON reporter records `spec.file` relative to the testDir, so it is the
    // bare filename here (`verify-failure.spec.ts`) rather than the repo path.
    if (basename(result.specFile) !== basename(NEGATIVE_SPEC_REL)) {
      throw new Error(
        `failed spec file ${JSON.stringify(result.specFile)} != ${NEGATIVE_SPEC_REL}`,
      );
    }
    if (typeof result.specLine !== 'number' || result.specLine <= 0) {
      throw new Error(
        `failed spec has no usable source line (got ${JSON.stringify(result.specLine)})`,
      );
    }

    const errorText = result.errors
      .map((error) => `${error.message ?? ''}\n${error.stack ?? ''}`)
      .join('\n');
    // Quoted so the check can't be satisfied by incidental digits (e.g. the
    // 5000ms timeout): Playwright records `Expected: "999"` / `Received: "0"`.
    if (!errorText.includes('"999"')) {
      throw new Error('failure message does not record the expected counter value "999"');
    }
    if (!errorText.includes('"0"')) {
      throw new Error('failure message does not record the actual counter value "0"');
    }

    const screenshot = result.attachments.find(
      (attachment) => attachment.contentType === 'image/png' || attachment.name === 'screenshot',
    );
    if (screenshot === undefined) {
      throw new Error('no screenshot attachment recorded for the failing test');
    }
    const screenshotPath = resolveAttachmentPath(screenshot.path);
    if (screenshotPath === null || !existsSync(screenshotPath)) {
      throw new Error(`screenshot attachment file missing (${screenshot.path})`);
    }
    const signature = readFileSync(screenshotPath).subarray(0, 8);
    const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!signature.equals(PNG_SIGNATURE)) {
      throw new Error('screenshot attachment is not a valid PNG');
    }

    const diagnostics = result.attachments.find(
      (attachment) => attachment.name === 'browser-diagnostics',
    );
    if (diagnostics === undefined) {
      throw new Error('no browser-diagnostics attachment recorded for the failing test');
    }
    const diagnosticsPath = resolveAttachmentPath(diagnostics.path);
    if (diagnosticsPath === null || !existsSync(diagnosticsPath)) {
      throw new Error(`browser-diagnostics file missing (${diagnostics.path})`);
    }
    const diagnosticsData = JSON.parse(readFileSync(diagnosticsPath, 'utf8'));
    const failedRequest = (diagnosticsData.failedRequests ?? []).find(
      (request) => typeof request.url === 'string' && request.url.includes(NEGATIVE_ROUTE),
    );
    if (failedRequest === undefined) {
      throw new Error('diagnostics did not record the aborted proof-ping request');
    }
    if (failedRequest.url.includes(NEGATIVE_TOKEN) || failedRequest.url.includes('__proof_token')) {
      throw new Error('diagnostics retained the query token in a recorded URL');
    }
    const capturedConsole = (diagnosticsData.consoleErrors ?? []).some(
      (text) => typeof text === 'string' && text.includes(NEGATIVE_CONSOLE_MARKER),
    );
    if (!capturedConsole) {
      throw new Error('diagnostics did not capture the benign console error');
    }

    const trace = result.attachments.find(
      (attachment) => attachment.name === 'trace' || attachment.contentType === 'application/zip',
    );
    if (trace === undefined) {
      throw new Error('no trace attachment recorded (JSAILS_TRACE=1 was set)');
    }
    const tracePath = resolveAttachmentPath(trace.path);
    if (tracePath === null || !existsSync(tracePath)) {
      throw new Error(`trace file missing (${trace.path})`);
    }

    // Copy the failure evidence out before the green re-run overwrites the report.
    copyEvidenceArtifact(
      reportPath,
      'negative-results.json',
      'JSON report for the intentional failure',
    );
    copyEvidenceArtifact(
      screenshotPath,
      `negative-${basename(screenshotPath)}`,
      'failure screenshot (PNG)',
    );
    copyEvidenceArtifact(
      diagnosticsPath,
      'negative-browser-diagnostics.json',
      'sanitized browser diagnostics',
    );
    copyEvidenceArtifact(tracePath, 'negative-trace.zip', 'Playwright trace (opt-in)');

    // Remove the failing spec and re-run the original tests green (no rebuild).
    // Only the non-auth specs run: the auth journey is database-gated and is
    // exercised by its own stage, never by this diagnostics proof.
    rmSync(specPath, { force: true });
    const nonAuthSpecs = collectSpecFiles(join(FIXTURE_DIR, 'test', 'browser'))
      .filter((file) => basename(file) !== basename(BROWSER_AUTH_SPEC))
      .map((file) => relative(FIXTURE_DIR, file));
    const greenRun = await runCommandResult(process.execPath, [cli, 'test', ...nonAuthSpecs], {
      cwd: FIXTURE_DIR,
      env: {
        JSAILS_BROWSER_PATH: BROWSER_PATH,
        JSAILS_TEST_PORT: String(port),
      },
      timeoutMs: NPM_TIMEOUT_MS,
      label: 'playwright test (green after removal)',
    });
    if (greenRun.code !== 0) {
      throw new Error(
        `original tests not green after removing the failing spec: exit ${greenRun.code}\n` +
          `--- stdout (tail) ---\n${tail(greenRun.stdout)}\n--- stderr (tail) ---\n${tail(greenRun.stderr)}`,
      );
    }
    const greenReport = JSON.parse(readFileSync(reportPath, 'utf8'));
    if ((greenReport.stats?.unexpected ?? 0) !== 0) {
      throw new Error(
        `green re-run reported ${greenReport.stats.unexpected} unexpected failure(s)`,
      );
    }
    const greenCount = greenReport.stats?.expected ?? 0;
    copyEvidenceArtifact(
      reportPath,
      'green-results.json',
      'JSON report for the green re-run after removal',
    );

    return (
      `expected exit 1 proven (${result.specFile}:${result.specLine}, expected 999 vs actual 0); ` +
      `screenshot + diagnostics + trace captured; original ${greenCount} test(s) green after removal`
    );
  } finally {
    rmSync(specPath, { force: true });
  }
}

/**
 * The native negative proof: temporarily append a failing `node:test` case to
 * the *existing* `test/app.test.ts`, recompile, and run `npm run test:report`.
 * Assert the expected exit 1 plus the JUnit failure, the recorded expected vs
 * actual values, and the source-mapped `test/app.test.ts` location
 * (`--enable-source-maps` maps the compiled stack back to the original TS). Then
 * restore the original source and re-run green, asserting the same compiled
 * `dist/test/app.test.js` was overwritten in place with no stale extra test file.
 * Throws on any deviation from the expected failure, so the proof can never
 * falsely pass.
 */
async function runNativeNegativeProof() {
  const appTestPath = join(FIXTURE_DIR, NATIVE_APP_TEST_REL);
  const junitPath = join(FIXTURE_DIR, 'test-results', 'junit.xml');
  // Deliberately nonexistent browser binary, so any accidental browser probe in
  // the native path would fail loudly instead of silently passing.
  const fakeBrowser = join(FIXTURE_DIR, 'no-such-browser-binary');
  const env = { JSAILS_BROWSER_PATH: fakeBrowser };

  const original = readFileSync(appTestPath, 'utf8');
  writeFileSync(appTestPath, original + NATIVE_FAILURE_SOURCE);
  try {
    const failRun = await runCommandResult('npm', ['run', 'test:report'], {
      cwd: FIXTURE_DIR,
      env,
      timeoutMs: NPM_TIMEOUT_MS,
      label: 'npm run test:report (intentional node failure)',
    });
    if (failRun.code !== 1) {
      throw new Error(
        `expected the failing native test to exit 1, got ${failRun.code}\n` +
          `--- stdout (tail) ---\n${tail(failRun.stdout)}\n--- stderr (tail) ---\n${tail(failRun.stderr)}`,
      );
    }

    const junit = readFileSync(junitPath, 'utf8');
    if (!junit.includes('<failure')) {
      throw new Error('JUnit report does not record a <failure> for the intentional native test');
    }
    for (const needle of [NATIVE_FAILURE_ACTUAL, NATIVE_FAILURE_EXPECTED, NATIVE_FAILURE_MARKER]) {
      if (!junit.includes(needle)) {
        throw new Error(`JUnit failure does not record ${JSON.stringify(needle)}`);
      }
    }
    // `--enable-source-maps` must map the failure back to the original TS source:
    // both the `<testcase file="...app.test.ts">` attribute and a stack frame
    // `app.test.ts:<line>:<col>`.
    if (!/file="[^"]*app\.test\.ts"/.test(junit)) {
      throw new Error('JUnit testcase file attribute does not point at test/app.test.ts');
    }
    if (!/app\.test\.ts:\d+:\d+/.test(junit)) {
      throw new Error('JUnit failure stack does not record a source-mapped app.test.ts:line:col');
    }

    copyEvidenceArtifact(
      junitPath,
      'native-failure.xml',
      'JUnit report for the intentional native node failure',
    );

    // Restore the original source, recompile, and re-run green. The recompile
    // overwrites the same dist/test/app.test.js in place (never a new file).
    writeFileSync(appTestPath, original);
    const greenRun = await runCommandResult('npm', ['run', 'test:report'], {
      cwd: FIXTURE_DIR,
      env,
      timeoutMs: NPM_TIMEOUT_MS,
      label: 'npm run test:report (green after restore)',
    });
    if (greenRun.code !== 0) {
      throw new Error(
        `native tests not green after restoring the source: exit ${greenRun.code}\n` +
          `--- stdout (tail) ---\n${tail(greenRun.stdout)}\n--- stderr (tail) ---\n${tail(greenRun.stderr)}`,
      );
    }
    const greenJunit = readFileSync(junitPath, 'utf8');
    if ((greenJunit.match(/<failure\b/g) ?? []).length !== 0) {
      throw new Error('green re-run recorded a failure in JUnit');
    }
    if (greenJunit.includes(NATIVE_FAILURE_MARKER) || greenJunit.includes(NATIVE_FAILURE_ACTUAL)) {
      throw new Error('green JUnit report still carries the intentional-failure markers');
    }

    // The appended proof compiled into the same dist/test/app.test.js, which the
    // green recompile overwrote in place — assert no stale extra .test.js remains.
    const compiled = collectCompiledTestFiles(join(FIXTURE_DIR, 'dist', 'test'));
    if (
      JSON.stringify(compiled) !==
      JSON.stringify(['dist/test/app.test.js', 'dist/test/auth.test.js'])
    ) {
      throw new Error(`unexpected compiled test files after restore: ${JSON.stringify(compiled)}`);
    }

    copyEvidenceArtifact(
      junitPath,
      'native-green.xml',
      'JUnit report for the green re-run after source restore',
    );

    return (
      `expected exit 1 proven (app.test.ts source location, ${NATIVE_FAILURE_ACTUAL} vs ` +
      `${NATIVE_FAILURE_EXPECTED}); native suite green after restore (no stale extra .test.js)`
    );
  } finally {
    // Always restore the original source, whatever the proof observed.
    writeFileSync(appTestPath, original);
  }
}

async function main(skipBrowser) {
  const results = [];
  const run = async (name, prereqs, fn) => {
    const blockedBy = prereqs.find((prereq) => {
      const state = results.find((entry) => entry.name === prereq);
      return state === undefined || state.status !== 'ok';
    });
    if (blockedBy !== undefined) {
      results.push({
        name,
        status: 'skipped',
        detail: `prerequisite "${blockedBy}" not satisfied`,
        durationMs: 0,
      });
      return;
    }
    log(`stage ${name} ...`);
    const started = Date.now();
    try {
      const detail = await fn();
      results.push({ name, status: 'ok', detail: detail ?? '', durationMs: Date.now() - started });
      log(`stage ${name} OK${detail ? ` — ${detail}` : ''} (${Date.now() - started} ms)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ name, status: 'failed', detail: message, durationMs: Date.now() - started });
      log(`stage ${name} FAILED — ${message}`);
    }
  };

  // The negative proof "succeeds" only when the temporary spec fails exactly as
  // expected. Its result is reported under a distinct `expected-failure` status
  // (never `ok`, never `failed` on success) so it can never be a false pass.
  const runProof = async (name, prereqs, fn) => {
    const blockedBy = prereqs.find((prereq) => {
      const state = results.find((entry) => entry.name === prereq);
      return state === undefined || state.status !== 'ok';
    });
    if (blockedBy !== undefined) {
      results.push({
        name,
        status: 'skipped',
        detail: `prerequisite "${blockedBy}" not satisfied`,
        durationMs: 0,
      });
      return;
    }
    log(`stage ${name} ...`);
    const started = Date.now();
    try {
      const detail = await fn();
      results.push({
        name,
        status: 'expected-failure',
        detail: detail ?? '',
        durationMs: Date.now() - started,
      });
      log(
        `stage ${name} EXPECTED FAILURE PROVEN${detail ? ` — ${detail}` : ''} (${Date.now() - started} ms)`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ name, status: 'failed', detail: message, durationMs: Date.now() - started });
      log(`stage ${name} FAILED — ${message}`);
    }
  };

  let tarballPath = null;

  // Browser stages are gated on `--skip-browser`: when set they are recorded as
  // explicit skips (never run, never probed) and the non-browser pipeline still
  // runs in full. Default mode (no flag) runs every stage unchanged.
  const runBrowser = (name, prereqs, fn) => {
    if (skipBrowser) {
      results.push({
        name,
        status: 'skipped',
        detail: '--skip-browser: browser stage not run',
        durationMs: 0,
      });
      log(`stage ${name} SKIPPED — --skip-browser`);
      return;
    }
    return run(name, prereqs, fn);
  };
  const runBrowserProof = (name, prereqs, fn) => {
    if (skipBrowser) {
      results.push({
        name,
        status: 'skipped',
        detail: '--skip-browser: browser negative proof not run',
        durationMs: 0,
      });
      log(`stage ${name} SKIPPED — --skip-browser`);
      return;
    }
    return runProof(name, prereqs, fn);
  };

  // Database-gated stage: when the MariaDB connection variables are absent the
  // stage is recorded as an explicit skip (never silently passed) and its body
  // never runs. When they are present it runs like any other stage.
  const runAuthStage = (name, prereqs, fn) => {
    if (!hasDatabase) {
      results.push({
        name,
        status: 'skipped',
        detail: DATABASE_SKIP_REASON,
        durationMs: 0,
      });
      log(`stage ${name} SKIPPED — ${DATABASE_SKIP_REASON}`);
      return;
    }
    return run(name, prereqs, fn);
  };

  // The auth browser journey is both database-gated and browser-gated. The
  // database gate is evaluated first so a missing MariaDB is always reported as
  // the explicit database skip, even under `--skip-browser`.
  const runAuthBrowser = (name, prereqs, fn) => {
    if (!hasDatabase) {
      results.push({
        name,
        status: 'skipped',
        detail: DATABASE_SKIP_REASON,
        durationMs: 0,
      });
      log(`stage ${name} SKIPPED — ${DATABASE_SKIP_REASON}`);
      return;
    }
    return runBrowser(name, prereqs, fn);
  };

  await run('build-root', [], async () => {
    await runCommand('npm', ['run', 'build'], { cwd: REPO_ROOT, label: 'build root' });
  });

  await run('pack', ['build-root'], async () => {
    mkdirSync(PACK_DIR, { recursive: true });
    await runCommand('npm', ['pack', '--pack-destination', PACK_DIR], {
      cwd: REPO_ROOT,
      label: 'npm pack',
    });
    const tarballs = readdirSync(PACK_DIR).filter((file) => file.endsWith('.tgz'));
    if (tarballs.length !== 1) {
      throw new Error(
        `expected exactly one .tgz in ${PACK_DIR}, found ${JSON.stringify(tarballs)}`,
      );
    }
    tarballPath = join(PACK_DIR, tarballs[0]);
    return tarballs[0];
  });

  await run('generate-fixture', ['pack'], async () => {
    // The real `jsails create` CLI: scaffold + a real `npm install`, with the
    // install isolated through npm's environment config so no lifecycle hooks
    // run in the public dependency graph. `--name` keeps the package name clean
    // while the fixture directory itself carries spaces and a literal `$`.
    await runCommand(
      process.execPath,
      [
        REPO_CLI,
        'create',
        FIXTURE_DIR,
        '--name',
        FIXTURE_NAME,
        '--jsails-dependency',
        `file:${tarballPath}`,
        '--install',
      ],
      {
        cwd: REPO_ROOT,
        env: {
          npm_config_ignore_scripts: 'true',
          npm_config_audit: 'false',
          npm_config_fund: 'false',
        },
        timeoutMs: NPM_TIMEOUT_MS,
        label: 'jsails create --install',
      },
    );
    if (!existsSync(join(FIXTURE_DIR, 'package.json'))) {
      throw new Error(`create produced no package.json under ${FIXTURE_DIR}`);
    }
    if (!existsSync(join(FIXTURE_DIR, 'node_modules', 'jsails', 'package.json'))) {
      throw new Error('create --install did not install the packaged jsails dependency');
    }
    const pkg = JSON.parse(readFileSync(join(FIXTURE_DIR, 'package.json'), 'utf8'));
    if (pkg.name !== FIXTURE_NAME) {
      throw new Error(`created package name ${JSON.stringify(pkg.name)} != ${FIXTURE_NAME}`);
    }
    if (pkg.dependencies?.jsails !== `file:${tarballPath}`) {
      throw new Error(
        `created package jsails dependency ${JSON.stringify(pkg.dependencies?.jsails)} != file:${tarballPath}`,
      );
    }
    return `scaffolded + installed ${FIXTURE_NAME} via the real create CLI`;
  });

  await run('packaged-import', ['generate-fixture'], async () => {
    // Runs against the *installed* copy so bare `import('jsails')` resolves the
    // packaged module, proving it can read its own bundled templates + AGENTS.md.
    const script = `
      const { createStarterFiles } = await import('jsails');
      const { files } = await createStarterFiles();
      const keys = Object.keys(files).sort();
      const expected = ${JSON.stringify(EXPECTED_KEYS)};
      if (JSON.stringify(keys) !== JSON.stringify(expected)) {
        throw new Error('unexpected file set: ' + JSON.stringify(keys));
      }
      for (const key of keys) {
        if (typeof files[key] !== 'string' || files[key].length === 0) {
          throw new Error('empty generated file: ' + key);
        }
      }
      if (!files['AGENTS.md'].includes('Working with JSails')) {
        throw new Error('bundled AGENTS.md guide missing from packaged module');
      }
      if (!/@import ['"]tailwindcss['"]/.test(files['ui/styles.css'])) {
        throw new Error('bundled styles template missing from packaged module');
      }
      if (!files['pages/index.tsx'].includes('counter-root')) {
        throw new Error('bundled page template missing from packaged module');
      }
      // The blog variant adds the two blog pages and a blog-wired app config.
      const blogFiles = await createStarterFiles({ blog: true });
      if (Object.keys(blogFiles.files).length !== 49) {
        throw new Error('blog variant must produce 49 files, got ' + Object.keys(blogFiles.files).length);
      }
      if (!blogFiles.files['pages/blog/index.tsx'] || !blogFiles.files['pages/blog/[slug].tsx']) {
        throw new Error('blog variant missing the two blog pages');
      }
      if (!blogFiles.files['jsails.app.js'].includes("'jsails/blog'")) {
        throw new Error("blog variant app config missing 'jsails/blog'");
      }
      console.log('PACKAGED_STARTER_OK ' + keys.length + ' files (blog variant 49)');
    `;
    await runCommand(process.execPath, ['--input-type=module', '-e', script], {
      cwd: FIXTURE_DIR,
      label: 'packaged createStarterFiles',
    });
    return 'packaged module reads its bundled templates + AGENTS.md';
  });

  await run('check-fixture', ['generate-fixture'], async () => {
    await runCommand('npm', ['run', 'check'], { cwd: FIXTURE_DIR, label: 'fixture npm run check' });
  });

  await run('static-export', ['check-fixture'], async () => {
    // `npm run check` already ran the full build (which includes the static
    // export); validate the produced `out/` artifacts instead of rebuilding.
    // `/` -> index.html, `/about` -> about/index.html, `/tasks` ->
    // tasks/index.html, and the two fixed assets land under assets/.
    for (const rel of [
      'index.html',
      'about/index.html',
      'tasks/index.html',
      'assets/app.js',
      'assets/app.css',
    ]) {
      if (!existsSync(join(FIXTURE_DIR, 'out', rel))) {
        throw new Error(`static export is missing out/${rel}`);
      }
    }
    return 'out/ index + about/tasks pages + assets/app.js + assets/app.css validated in place';
  });

  await run('native-test', ['check-fixture'], async () => {
    // The documented server-only path: `npm run test:report` compiles the backend
    // (`tsc -p tsconfig.json`) and runs the compiled `node:test` suite in-process
    // with a spec reporter on stdout plus a JUnit report at
    // `test-results/junit.xml`. `JSAILS_BROWSER_PATH` points at a deliberately
    // nonexistent binary to prove this path never probes or launches a browser.
    const junitPath = join(FIXTURE_DIR, 'test-results', 'junit.xml');
    const fakeBrowser = join(FIXTURE_DIR, 'no-such-browser-binary');
    await runCommand('npm', ['run', 'test:report'], {
      cwd: FIXTURE_DIR,
      env: { JSAILS_BROWSER_PATH: fakeBrowser },
      timeoutMs: NPM_TIMEOUT_MS,
      label: 'fixture npm run test:report',
    });
    if (!existsSync(junitPath)) {
      throw new Error('test:report did not produce test-results/junit.xml');
    }
    const junit = readFileSync(junitPath, 'utf8');
    const testCount = (junit.match(/<testcase\b/g) ?? []).length;
    const failCount = (junit.match(/<failure\b/g) ?? []).length;
    const skippedCount = (junit.match(/<skipped\b/g) ?? []).length;
    // Derive the expected count from the shipped sources, never a hardcoded
    // number, so adding a case keeps this assertion correct. The native suite is
    // two files: `app.test.ts` (server behavior, always runs) and `auth.test.ts`
    // (database-backed, which skips itself when no MariaDB is configured).
    const appTestPath = join(FIXTURE_DIR, 'test', 'app.test.ts');
    const authTestPath = join(FIXTURE_DIR, 'test', 'auth.test.ts');
    const expectedCount = countDeclaredTests([appTestPath, authTestPath]);
    if (testCount !== expectedCount) {
      throw new Error(
        `expected ${expectedCount} native node:test cases, JUnit recorded ${testCount}`,
      );
    }
    if (failCount !== 0) {
      throw new Error(`native node:test suite recorded ${failCount} failure(s)`);
    }
    // Without a database every auth case must be an explicit skip; with one none
    // may be skipped. This proves the auth suite never silently passes.
    const expectedAuthSkips = hasDatabase ? 0 : countDeclaredTests([authTestPath]);
    if (skippedCount !== expectedAuthSkips) {
      throw new Error(
        `expected ${expectedAuthSkips} skipped node:test case(s), JUnit recorded ${skippedCount}`,
      );
    }
    copyEvidenceArtifact(
      junitPath,
      'native-pass.xml',
      'JUnit report for the passing native node:test suite',
    );
    return (
      `${expectedCount} native node:test cases via npm run test:report ` +
      `(${expectedCount - skippedCount} ran, ${skippedCount} skipped${
        hasDatabase ? '' : ' — auth suite skipped, no database'
      }; browser-independent, JSAILS_BROWSER_PATH nonexistent)`
    );
  });

  await runProof('native-test-fail-proof', ['native-test'], async () => {
    return runNativeNegativeProof();
  });

  await runAuthStage('auth-migrate', ['check-fixture'], async () => {
    // Better Auth's tables are created in the configured MariaDB. The script
    // imports `createAuth` from the framework's `jsails/auth` plugin directly
    // (no compiled app module is required), so it is gated only on
    // `check-fixture`. The secret is passed explicitly so the
    // migrate/create/serve/browser chain shares one value.
    await runCommand('npm', ['run', 'auth:migrate'], {
      cwd: FIXTURE_DIR,
      env: { BETTER_AUTH_SECRET: BETTER_AUTH_SECRET_VALUE },
      timeoutMs: NPM_TIMEOUT_MS,
      label: 'fixture npm run auth:migrate',
    });
    return 'Better Auth tables migrated in the configured MariaDB';
  });

  await runAuthStage('user-create', ['auth-migrate'], async () => {
    // Seed the account the auth browser journey signs in with. The password is
    // passed to the script but never echoed.
    await runCommand(
      'npm',
      ['run', 'user:create', '--', AUTH_TEST_EMAIL, AUTH_TEST_PASSWORD, 'Verify User'],
      {
        cwd: FIXTURE_DIR,
        env: { BETTER_AUTH_SECRET: BETTER_AUTH_SECRET_VALUE },
        timeoutMs: NPM_TIMEOUT_MS,
        label: 'fixture npm run user:create',
      },
    );
    return `seeded auth account ${AUTH_TEST_EMAIL}`;
  });

  await runBrowser('browser-test-pass', ['static-export'], async () => {
    // The documented `npm run test:browser`: builds the app, then drives the
    // generated non-auth Playwright journeys (soft navigation, the signed
    // server-component actions, and the in-flight morph) against an isolated
    // local server using the system Chromium and a reserved free port. The auth
    // journey is database-gated and runs in its own stage, so it is excluded
    // here and the expected count is derived from the non-auth specs only.
    const nonAuthSpecs = collectSpecFiles(join(FIXTURE_DIR, 'test', 'browser'))
      .filter((file) => basename(file) !== basename(BROWSER_AUTH_SPEC))
      .map((file) => relative(FIXTURE_DIR, file));
    const port = await findFreePort();
    await runCommand('npm', ['run', 'test:browser', '--', ...nonAuthSpecs], {
      cwd: FIXTURE_DIR,
      env: {
        JSAILS_BROWSER_PATH: BROWSER_PATH,
        JSAILS_TEST_PORT: String(port),
      },
      timeoutMs: NPM_TIMEOUT_MS,
      label: 'fixture npm run test:browser (non-auth journeys)',
    });
    const reportPath = join(FIXTURE_DIR, 'test-results', 'results.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    if ((report.stats?.unexpected ?? 0) !== 0) {
      throw new Error(`test:browser reported ${report.stats.unexpected} unexpected failure(s)`);
    }
    const expected = report.stats?.expected ?? 0;
    // Derive the expected journey count from the shipped spec sources, never a
    // hardcoded floor, so new cases keep this assertion correct.
    const specCount = countDeclaredTests(nonAuthSpecs.map((file) => join(FIXTURE_DIR, file)));
    if (expected !== specCount) {
      throw new Error(`test:browser expected ${specCount} passing journeys, reported ${expected}`);
    }
    copyEvidenceArtifact(
      reportPath,
      'pass-results.json',
      'JSON report for the passing generated journeys',
    );
    return `${expected} non-auth generated journey(s) passed via Playwright (system Chromium, isolated port ${port})`;
  });

  await runAuthBrowser('browser-auth', ['user-create', 'static-export'], async () => {
    // The database-gated auth journey: signs the seeded account in and out in a
    // real browser against an isolated server. Runs only when a live MariaDB and
    // the seeded account exist; otherwise it is recorded as an explicit skip.
    const port = await findFreePort();
    await runCommand('npm', ['run', 'test:browser', '--', BROWSER_AUTH_SPEC], {
      cwd: FIXTURE_DIR,
      env: {
        JSAILS_BROWSER_PATH: BROWSER_PATH,
        JSAILS_TEST_PORT: String(port),
        BETTER_AUTH_SECRET: BETTER_AUTH_SECRET_VALUE,
        AUTH_TEST_EMAIL,
        AUTH_TEST_PASSWORD,
      },
      timeoutMs: NPM_TIMEOUT_MS,
      label: 'fixture npm run test:browser (auth journey)',
    });
    const reportPath = join(FIXTURE_DIR, 'test-results', 'results.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    if ((report.stats?.unexpected ?? 0) !== 0) {
      throw new Error(
        `auth test:browser reported ${report.stats.unexpected} unexpected failure(s)`,
      );
    }
    const expected = report.stats?.expected ?? 0;
    const specCount = countDeclaredTests([join(FIXTURE_DIR, BROWSER_AUTH_SPEC)]);
    if (expected !== specCount) {
      throw new Error(
        `auth test:browser expected ${specCount} passing journey(s), reported ${expected}`,
      );
    }
    copyEvidenceArtifact(
      reportPath,
      'auth-pass-results.json',
      'JSON report for the passing auth browser journey',
    );
    return `${expected} auth browser journey(s) passed for ${AUTH_TEST_EMAIL} (system Chromium, isolated port ${port})`;
  });

  await runBrowserProof('browser-test-fail-proof', ['browser-test-pass'], async () => {
    return runNegativeProof();
  });

  await runBrowser('browser-serve', ['static-export'], async () => {
    // `NODE_ENV=test` lets the server-components extension mint its ephemeral
    // signing key (a plain `jsails serve` outside development/test fails a live
    // render closed), so the `/tasks` component renders for the SSR QA below.
    const served = await spawnServer({
      cmd: process.execPath,
      args: [INSTALLED_CLI, 'serve', '--config', 'jsails.app.js'],
      cwd: FIXTURE_DIR,
      env: { PORT: '0', NODE_ENV: 'test' },
      match: /Serving at (https?:\/\/\S+)/,
      timeoutMs: 30_000,
      label: 'jsails serve',
    });
    try {
      const observed = await runBrowserQa(served.url);
      const nav = await runNavigationQa(served.url);
      const tasks = await runServerComponentQa(served.url);
      return (
        `hydration/counter/dialog OK at ${served.url} (bg ${observed.styles.backgroundColor}); ` +
        `soft navigation preserved the window (${nav.heading}); ` +
        `server component add/clear/422 OK (${tasks.items} task)`
      );
    } finally {
      await served.stop();
    }
  });

  await runBrowser('browser-static', ['static-export'], async () => {
    // Pure static proof: serve the exported out/ with Hono + serve-static, no
    // jsails backend, and confirm hydration + counter still work.
    const staticScript = `
      import { serve } from '@hono/node-server';
      import { serveStatic } from '@hono/node-server/serve-static';
      import { Hono } from 'hono';
      const app = new Hono();
      app.use('*', serveStatic({ root: './out' }));
      serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        console.log('STATIC_AT http://127.0.0.1:' + info.port + '/');
      });
    `;
    const served = await spawnServer({
      cmd: process.execPath,
      args: ['--input-type=module', '-e', staticScript],
      cwd: FIXTURE_DIR,
      env: process.env,
      match: /STATIC_AT (https?:\/\/\S+)/,
      timeoutMs: 30_000,
      label: 'static serve of out/',
    });
    try {
      const observed = await runBrowserQa(served.url);
      await runNavigationQa(served.url);
      const tasks = await runStaticTasksQa(served.url);
      return (
        `pure static out/ OK at ${served.url} (bg ${observed.styles.backgroundColor}); ` +
        `soft navigation preserved the window; ` +
        `static tasks read-only fallback OK (counter ${tasks.counter})`
      );
    } finally {
      await served.stop();
    }
  });

  await runBrowser('dev-server', ['static-export'], async () => {
    // Real `jsails dev`: initial build, watch, nodemon restarts, and a live
    // serve child. The owned process tree is snapshotted via /proc metadata
    // *before* teardown, and only those captured descendants are checked and
    // (with a starttime guard against PID reuse) killed. Unrelated processes'
    // environment is never read and no unowned process is signalled.
    let dev = null;
    let failure = null;
    let summary = '';
    let before = null;
    try {
      dev = await spawnDevServer({
        cmd: process.execPath,
        args: [INSTALLED_CLI, 'dev', '--config', 'jsails.app.js'],
        cwd: FIXTURE_DIR,
        env: { PORT: '0' },
        label: 'jsails dev',
      });
      summary = await exerciseDevServer(dev);
    } catch (error) {
      failure = error;
    } finally {
      if (dev !== null) {
        // Capture before teardown: after the parent exits, its detached children
        // re-parent to init, which would hide them from a post-hoc tree walk.
        before = snapshotProcessTree([dev.pid]);
        try {
          await dev.stop();
        } catch (stopError) {
          if (failure === null) failure = stopError;
        }
      }
    }
    const leaked = before === null ? [] : await settleProcessTree(before, DEV_LEAK_SETTLE_MS);
    if (leaked.length > 0) {
      killLeakedProcesses(leaked);
      if (failure === null) {
        failure = new Error(
          `jsails dev leaked ${leaked.length} child process(es) after teardown: ` +
            leaked.map((entry) => entry.pid).join(', '),
        );
      }
    }
    if (failure !== null) throw failure;
    return summary;
  });

  return results;
}

async function cleanup() {
  for (const child of [...owned]) {
    await stopChild(child);
  }
  if (browser !== null) {
    try {
      await browser.close();
    } catch {
      // The browser is best-effort to close; never mask the real result.
    }
    browser = null;
  }
  try {
    rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch {
    // A leftover temp dir is preferable to failing the run on cleanup.
  }
}

let results = [];
let versions = {};
let skipBrowser = false;
try {
  skipBrowser = parseFlags(process.argv.slice(2));
  initEvidence();
  results = await main(skipBrowser);
} catch (error) {
  results = [
    {
      name: 'verify-starter',
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
      durationMs: 0,
    },
  ];
} finally {
  // Capture versions before teardown removes the fixture's node_modules.
  try {
    versions = collectVersions(skipBrowser);
  } catch {
    versions = {};
  }
  await cleanup();
}

const succeeded = results.filter((entry) => entry.status === 'ok');
const failed = results.filter((entry) => entry.status === 'failed');
const skipped = results.filter((entry) => entry.status === 'skipped');
const expectedFailures = results.filter((entry) => entry.status === 'expected-failure');

log('');
log('=== verify:starter summary ===');
log(`succeeded: ${succeeded.length}`);
for (const entry of succeeded) log(`  - ${entry.name}${entry.detail ? `: ${entry.detail}` : ''}`);
log(`expected failures (negative proof, not counted as passes): ${expectedFailures.length}`);
for (const entry of expectedFailures) log(`  - ${entry.name}: ${entry.detail}`);
log(`failed: ${failed.length}`);
for (const entry of failed) log(`  - ${entry.name}: ${entry.detail}`);
log(`skipped: ${skipped.length}`);
for (const entry of skipped) log(`  - ${entry.name}: ${entry.detail}`);
log(
  `database: ${
    hasDatabase
      ? 'configured — auth stages enabled'
      : `absent — auth stages skipped (missing ${missingDbVars.join(', ')})`
  }`,
);
log(`browser launched: ${browserLaunches}`);
log('dependency versions:');
for (const [name, version] of Object.entries(versions)) {
  log(`  - ${name}: ${version ?? 'unknown'}`);
}

// Persist the structured summary and copied evidence outside the temp root.
if (evidence !== null) {
  const summary = {
    schemaVersion: 1,
    runId: evidence.runId,
    status: failed.length === 0 ? 'passed' : 'failed',
    startedAt: evidence.startedAt,
    durationMs: Date.now() - evidence.startedAtMs,
    stages: results.map((entry) => ({
      name: entry.name,
      status: entry.status,
      detail: entry.detail,
      durationMs: entry.durationMs ?? 0,
    })),
    errors: failed.map((entry) => entry.detail),
    artifacts: evidence.artifacts,
    skipBrowser,
    database: {
      detected: hasDatabase,
      missing: [...missingDbVars],
    },
    browserLaunches,
  };
  try {
    writeFileSync(join(evidence.runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    log(`structured summary + evidence: ${relative(REPO_ROOT, evidence.runDir)}`);
    log(
      'note: dev-process leak detection is limited to /proc process metadata on Linux — no global leak proof is claimed on platforms without it',
    );
  } catch (writeError) {
    log(`warning: could not persist the structured summary — ${writeError.message}`);
  }
}

process.exitCode = failed.length === 0 ? 0 : 1;
