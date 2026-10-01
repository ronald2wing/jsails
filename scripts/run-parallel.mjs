// Runs several `npm run <script>` jobs concurrently and fails the whole run if
// any of them fails. Used by `check` to overlap the read-only phases (lint,
// format:check) that would otherwise serialize. Each job inherits stdio so its
// output stays live and ordered per-job; the exit code is the first failure's.
//
// Usage: node scripts/run-parallel.mjs <script> <script> [...]
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = process.argv.slice(2);
if (scripts.length === 0) {
  console.error('Usage: node scripts/run-parallel.mjs <script> [<script> ...]');
  process.exit(2);
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const children = scripts.map((name) =>
  spawn('npm', ['run', name], { stdio: 'inherit', cwd: projectRoot }),
);

const failures = [];
let remaining = children.length;

/** Terminate every still-running sibling once one job has failed. */
function killAll(except) {
  for (const child of children) {
    if (child !== except && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
  }
}

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (signal === null && code !== 0) {
      failures.push({ code, signal });
      killAll(child);
    }
    remaining -= 1;
    if (remaining === 0) {
      process.exit(failures.length > 0 ? (failures[0].code ?? 1) : 0);
    }
  });
  child.on('error', (error) => {
    console.error(`Failed to start "npm run ${scripts[children.indexOf(child)]}":`, error.message);
    failures.push({ code: 1, signal: null });
    killAll(child);
    remaining -= 1;
    if (remaining === 0) process.exit(1);
  });
}
