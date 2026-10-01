/**
 * Built-in deploy-generator adapters.
 *
 * Each adapter wraps an existing pure generator from `database-config.ts` or
 * `valkey-config.ts`/`kamal-config.ts` without changing it: the underlying
 * function still owns validation and option defaults. The adapter only checks
 * that the input is a plain object (an unknown caller may pass anything), then
 * maps the generator's string fields onto portable relative file paths.
 *
 * File-path choices follow the field semantics:
 * - dev Valkey / database emit a `docker-compose*.yml` plus an example env file.
 * - Kamal Valkey emits a complete `config/deploy.yml` (it declares web/worker
 *   roles) plus its uploaded config files and a `.kamal/secrets` example.
 * - Kamal database emits FRAGMENTS to merge into an existing deploy config, so
 *   it must NOT claim `config/deploy.yml`; its accessory/env/secrets outputs
 *   land on explicitly fragment-named paths.
 * - ONCE emits the app image build (`Dockerfile.once` + `.dockerignore`) and a
 *   `jsails.once.js` config wrapper, the Basecamp ONCE deployment preset.
 * - The four static-hosting generators emit a single config each — `vercel.json`,
 *   `netlify.toml`, `wrangler.toml`, and the GitHub Pages workflow — so a
 *   static export can ship to a static host instead of a container.
 */

import {
  generateDevDatabaseConfig,
  generateKamalDatabaseConfig,
  type DevDatabaseOptions,
  type KamalDatabaseOptions,
} from './database-config.js';
import { generateKamalValkeyConfig, type KamalValkeyOptions } from './kamal-config.js';
import { generateDevValkeyConfig, type ValkeyConfigOptions } from './valkey-config.js';
import { generateOnceConfig, type OnceConfigOptions } from './once-config.js';
import {
  generateCloudflarePagesConfig,
  generateGitHubPagesConfig,
  generateNetlifyStaticConfig,
  generateVercelStaticConfig,
  type CloudflarePagesOptions,
} from './hosting-config.js';
import type { DeploymentGenerator } from './registry.js';

/**
 * Deterministic built-in generator ids, in registration order.
 *
 * Report: `valkey-dev`, `valkey-kamal`, `database-dev`, `database-kamal`,
 * `once`, `vercel-static`, `netlify-static`, `cloudflare-pages`,
 * `github-pages`.
 */
export const BUILTIN_DEPLOYMENT_GENERATOR_IDS = [
  'valkey-dev',
  'valkey-kamal',
  'database-dev',
  'database-kamal',
  'once',
  'vercel-static',
  'netlify-static',
  'cloudflare-pages',
  'github-pages',
] as const;

/** A built-in generator id. */
export type BuiltinDeploymentGeneratorId = (typeof BUILTIN_DEPLOYMENT_GENERATOR_IDS)[number];

/**
 * Read a generator input as a plain options object. Only the container shape
 * is checked here; every field is validated by the wrapped generator, which
 * also applies its own defaults. `undefined` becomes `{}` so optionless
 * built-ins (dev Valkey, dev database) work with no argument.
 */
function asOptions<T extends object>(input: unknown): T {
  if (input === undefined) return {} as unknown as T;
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('deployment generator input must be a plain object');
  }
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError('deployment generator input must be a plain object');
  }
  return input as unknown as T;
}

const valkeyDevGenerator: DeploymentGenerator<unknown> = {
  name: 'valkey-dev',
  generate(input: unknown) {
    const { compose, valkeyConfig, startupScript, envExample } = generateDevValkeyConfig(
      asOptions<ValkeyConfigOptions>(input),
    );
    return {
      files: {
        'docker-compose.yml': compose,
        'valkey.conf': valkeyConfig,
        'start-valkey.sh': startupScript,
        '.env.example': envExample,
      },
    };
  },
};

const valkeyKamalGenerator: DeploymentGenerator<unknown> = {
  name: 'valkey-kamal',
  generate(input: unknown) {
    const { deploy, valkeyConfig, startupScript, secretsExample } = generateKamalValkeyConfig(
      asOptions<KamalValkeyOptions>(input),
    );
    return {
      files: {
        'config/deploy.yml': deploy,
        'config/valkey/valkey.conf': valkeyConfig,
        'config/valkey/start-valkey.sh': startupScript,
        '.kamal/secrets': secretsExample,
      },
    };
  },
};

const databaseDevGenerator: DeploymentGenerator<unknown> = {
  name: 'database-dev',
  generate(input: unknown) {
    const { compose, envExample } = generateDevDatabaseConfig(asOptions<DevDatabaseOptions>(input));
    return {
      files: {
        'docker-compose.database.yml': compose,
        '.env.database.example': envExample,
      },
    };
  },
};

const databaseKamalGenerator: DeploymentGenerator<unknown> = {
  name: 'database-kamal',
  generate(input: unknown) {
    const { accessory, envExample, secretsExample } = generateKamalDatabaseConfig(
      asOptions<KamalDatabaseOptions>(input),
    );
    // Fragments only: these merge into an existing config/deploy.yml and
    // .kamal/secrets, so they must not reuse those whole-config paths.
    return {
      files: {
        'config/deploy.database.yml': accessory,
        'config/deploy.database-env.yml': envExample,
        '.kamal/secrets.database.example': secretsExample,
      },
    };
  },
};

const onceGenerator: DeploymentGenerator<unknown> = {
  name: 'once',
  generate(input: unknown) {
    const { dockerfile, dockerignore, jsailsConfig } = generateOnceConfig(
      asOptions<OnceConfigOptions>(input),
    );
    return {
      files: {
        'Dockerfile.once': dockerfile,
        '.dockerignore': dockerignore,
        'jsails.once.js': jsailsConfig,
      },
    };
  },
};

const vercelStaticGenerator: DeploymentGenerator<unknown> = {
  name: 'vercel-static',
  generate(input: unknown) {
    const { vercelJson } = generateVercelStaticConfig(asOptions(input));
    return { files: { 'vercel.json': vercelJson } };
  },
};

const netlifyStaticGenerator: DeploymentGenerator<unknown> = {
  name: 'netlify-static',
  generate(input: unknown) {
    const { netlifyToml } = generateNetlifyStaticConfig(asOptions(input));
    return { files: { 'netlify.toml': netlifyToml } };
  },
};

const cloudflarePagesGenerator: DeploymentGenerator<unknown> = {
  name: 'cloudflare-pages',
  generate(input: unknown) {
    const { wranglerToml } = generateCloudflarePagesConfig(
      asOptions<CloudflarePagesOptions>(input),
    );
    return { files: { 'wrangler.toml': wranglerToml } };
  },
};

const githubPagesGenerator: DeploymentGenerator<unknown> = {
  name: 'github-pages',
  generate(input: unknown) {
    const { workflow, nojekyll } = generateGitHubPagesConfig(asOptions(input));
    return {
      files: {
        '.github/workflows/pages.yml': workflow,
        '.nojekyll': nojekyll,
      },
    };
  },
};

/** Built-in adapters in deterministic registration order. */
export const BUILTIN_DEPLOYMENT_GENERATORS: readonly DeploymentGenerator<unknown>[] = [
  valkeyDevGenerator,
  valkeyKamalGenerator,
  databaseDevGenerator,
  databaseKamalGenerator,
  onceGenerator,
  vercelStaticGenerator,
  netlifyStaticGenerator,
  cloudflarePagesGenerator,
  githubPagesGenerator,
];
