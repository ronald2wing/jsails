// The framework `build`: compile `src/` with `tsc` into `dist/`.
//
// There is no checked-in generated catalog to refresh. The framework-symbol
// table is derived per-app at the app's own `build:meta` step (from the
// framework's shipped `dist/**/index.d.ts` barrels, or from `src/` in-repo), so
// nothing here needs to scan or regenerate data. `tsc` emits the compiled
// barrels and their per-subpath `.d.ts` files — the exact inputs the app's
// scanner reads.
//
// Usage: node scripts/build.mjs
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const result = spawnSync('node_modules/.bin/tsc', ['-p', 'tsconfig.json'], {
  stdio: 'inherit',
  cwd: projectRoot,
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
