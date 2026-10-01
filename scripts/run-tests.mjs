// Runs the compiled node:test suite without relying on shell glob expansion,
// which is unavailable for the test runner on Node 20.19. Flags passed to this
// script are forwarded to `node --test` (e.g. --watch, --experimental-test-coverage).
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(projectRoot, 'dist', 'test');

if (!existsSync(testDir)) {
  console.error(`Missing build output: ${testDir} does not exist. Run "npm run build" first.`);
  process.exit(1);
}

function collectTests(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectTests(full));
    else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(full);
  }
  return files;
}

const testFiles = collectTests(testDir).sort();

if (testFiles.length === 0) {
  console.error(`No *.test.js files found under ${testDir}. Run "npm run build" first.`);
  process.exit(1);
}

// Default NODE_ENV for the test child only when the caller left it unset, so
// the server-components key path exercises its test-mode ephemeral key. Build a
// copy: never mutate this runner's own process.env.
const childEnv = { ...process.env };
if (childEnv.NODE_ENV === undefined) {
  childEnv.NODE_ENV = 'test';
}

const child = spawn(process.execPath, ['--test', ...process.argv.slice(2), ...testFiles], {
  stdio: 'inherit',
  env: childEnv,
});

const forwardedSignals = ['SIGINT', 'SIGTERM'];
const handlers = new Map(
  forwardedSignals.map((signal) => [
    signal,
    () => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    },
  ]),
);
for (const [signal, handler] of handlers) process.on(signal, handler);

child.on('exit', (code, signal) => {
  for (const [forwarded, handler] of handlers) process.removeListener(forwarded, handler);
  if (signal !== null) {
    process.exit(128 + (constants.signals[signal] ?? 0));
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error(`Failed to start test runner: ${error.message}`);
  process.exit(1);
});
