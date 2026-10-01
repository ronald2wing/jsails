/**
 * Process-environment assembly from developer-owned `.env` files.
 *
 * JSails follows the Node-ecosystem consensus for environment files (dotenv-flow,
 * Vite/Vitest, Next.js, Symfony, NestJS): a **cumulative merge** where `.env` is
 * always the base and the `NODE_ENV`-specific file layers on top, with a real
 * `process.env` variable always winning over every file. The developer owns
 * git-ignored `.env` files seeded from committed `.example` templates; this
 * module is the only place `.env` files are read. The validators
 * (`readEnvironment`, `readDatabaseEnvironment`) stay pure and read whatever
 * this bootstrap assembled.
 *
 * **Selection.** The signal is `NODE_ENV` (auto-set to `test` by `jsails test`,
 * matching Jest and Vitest):
 *
 * - `test` mode: load `.env`, then `.env.testing` (Laravel's name) — the test
 *   file overrides keys such as `DATABASE_NAME=*_test`. `.env.local` is skipped
 *   (determinism: dotenv-flow's rule that test results must not depend on a
 *   machine-local override).
 * - otherwise: load `.env`, `.env.local`, then `.env.${NODE_ENV}` — later wins.
 *
 * This is dotenv-flow's cumulative model with `.env.testing` as the test
 * override; the "tests never touch dev data" guarantee comes from
 * `.env.testing` overriding `DATABASE_NAME`, not from never loading `.env`.
 *
 * **Precedence.** A real `process.env` entry always wins. Uses the maintained
 * `dotenv` parser rather than a hand-rolled one.
 */

import { parse } from 'dotenv';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The base environment file, loaded in every mode. */
const DOTENV_BASE = '.env';
/** The developer-machine override of `.env`, skipped in test mode. */
const DOTENV_LOCAL = '.env.local';
/**
 * The test environment override: layered on `.env` under `NODE_ENV=test`. The
 * name follows Laravel's `.env.testing`; the semantics follow dotenv-flow
 * (`.env.${NODE_ENV}` with `NODE_ENV=test`).
 */
const DOTENV_TESTING = '.env.testing';

/** Options for {@link assembleEnvironment}. */
export interface AssembleEnvironmentOptions {
  /** Project root; `.env` files resolve under it. Defaults to `process.cwd()`. */
  readonly rootDir?: string;
  /** The environment name, from `NODE_ENV`. */
  readonly nodeEnv?: string;
  /** The env map to assemble into (defaults to `process.env`); injectable for tests. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Assemble `process.env` from the developer's `.env` files, never overwriting a
 * real environment variable.
 *
 /**
 * - `test` mode: load `.env`, then `.env.testing` (if present); skip `.env.local`
 *   (determinism — the one `test`-specific rule dotenv-flow keeps: test results
 *   should not depend on a developer's machine-local overrides).
 * - otherwise: load `.env`, `.env.local` (if present), then `.env.${nodeEnv}`
 *   (if `nodeEnv` is set and the file is present).
 * - A missing file is a silent no-op, never an error.
 */
export function assembleEnvironment(options: AssembleEnvironmentOptions = {}): void {
  const rootDir = options.rootDir ?? process.cwd();
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const env = options.env ?? process.env;

  // Keys already present before assembly are "real environment" values that a
  // file must never overwrite.
  const preExisting = new Set(Object.keys(env));

  const isTest = nodeEnv === 'test';

  load(join(rootDir, DOTENV_BASE), env, preExisting);
  if (isTest) {
    load(join(rootDir, DOTENV_TESTING), env, preExisting);
    return;
  }
  load(join(rootDir, DOTENV_LOCAL), env, preExisting);
  if (nodeEnv !== undefined && nodeEnv !== '') {
    load(join(rootDir, `${DOTENV_BASE}.${nodeEnv}`), env, preExisting);
  }
}

/**
 * Parse and apply one `.env` file into `env`. A key in `preExisting` (a real
 * environment variable) is never set; otherwise a later file wins, so a key an
 * earlier file set is overwritten by this one.
 */
function load(path: string, env: NodeJS.ProcessEnv, preExisting: ReadonlySet<string>): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return; // a missing `.env` file is not an error.
  }
  const parsed = parse(raw);
  for (const [key, value] of Object.entries(parsed)) {
    if (!preExisting.has(key)) {
      env[key] = value;
    }
  }
}
