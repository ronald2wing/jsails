import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ONCE_DEFAULT_BASE_IMAGE,
  ONCE_DOCKERFILE_FILENAME,
  ONCE_DOCKERIGNORE_FILENAME,
  ONCE_WRAPPER_FILENAME,
  OnceConfigError,
  generateOnceConfig,
  type OnceConfigOptions,
} from '../../src/deploy/once-config.js';

describe('generateOnceConfig', () => {
  it('produces exactly three string files with the frozen filenames', () => {
    assert.equal(ONCE_DOCKERFILE_FILENAME, 'Dockerfile.once');
    assert.equal(ONCE_DOCKERIGNORE_FILENAME, '.dockerignore');
    assert.equal(ONCE_WRAPPER_FILENAME, 'jsails.once.js');

    const { dockerfile, dockerignore, jsailsConfig } = generateOnceConfig();
    assert.equal(typeof dockerfile, 'string');
    assert.equal(typeof dockerignore, 'string');
    assert.equal(typeof jsailsConfig, 'string');
  });

  it('is pure: identical output for identical input, with no writes or secrets', () => {
    const a = generateOnceConfig();
    const b = generateOnceConfig();
    assert.deepEqual(a, b);

    const blob = `${a.dockerfile}\n${a.dockerignore}\n${a.jsailsConfig}`;
    // No secret is ever embedded: the env names are only ever read, never
    // assigned a literal value.
    assert.ok(!blob.includes('hunter2'));
  });

  it('emits a multi-stage Dockerfile on the default node:24 base image', () => {
    const { dockerfile } = generateOnceConfig();

    assert.ok(dockerfile.includes(`FROM ${ONCE_DEFAULT_BASE_IMAGE} AS builder`));
    assert.ok(dockerfile.includes(`FROM ${ONCE_DEFAULT_BASE_IMAGE} AS runtime`));
    assert.ok(dockerfile.includes('RUN npm ci'));
    assert.ok(dockerfile.includes('RUN npm run build'));
    assert.ok(dockerfile.includes('ENV NODE_ENV=production'));
    assert.ok(dockerfile.includes('RUN npm ci --omit=dev'));
    assert.ok(dockerfile.includes('COPY --from=builder /app/dist ./dist'));
    assert.ok(dockerfile.includes('COPY --from=builder /app/public ./public'));
    assert.ok(dockerfile.includes('COPY jsails.app.js ./jsails.app.js'));
    assert.ok(dockerfile.includes('COPY jsails.once.js ./jsails.once.js'));
    // The static export is deliberately not copied: SSR, not static files.
    assert.ok(!dockerfile.includes('COPY --from=builder /app/out'));
  });

  it('binds port 80, exposes it, and runs as the unprivileged node user', () => {
    const { dockerfile, jsailsConfig } = generateOnceConfig();

    assert.ok(dockerfile.includes('EXPOSE 80'));
    assert.ok(dockerfile.includes('USER node'));
    assert.ok(jsailsConfig.includes("host: '0.0.0.0',"));
    assert.ok(jsailsConfig.includes('port: 80,'));
  });

  it('creates and owns /storage (and /rails/storage) as node, since ONCE never chowns', () => {
    const { dockerfile, jsailsConfig } = generateOnceConfig();

    assert.ok(
      dockerfile.includes(
        'RUN mkdir -p /storage /rails/storage && chown -R node:node /storage /rails/storage',
      ),
    );
    assert.ok(jsailsConfig.includes("storage: '/storage',"));
  });

  it('invokes the installed jsails CLI bin to serve the wrapper config', () => {
    const { dockerfile } = generateOnceConfig();

    assert.ok(
      dockerfile.includes(
        'CMD ["node_modules/.bin/jsails", "serve", "--config", "jsails.once.js"]',
      ),
    );
  });

  it('derives publicOrigin from BASE_URL only when it is set, preserving the app config', () => {
    const { jsailsConfig } = generateOnceConfig();

    assert.ok(jsailsConfig.includes("import appConfig from './jsails.app.js';"));
    assert.ok(jsailsConfig.includes('  ...appConfig,'));
    assert.ok(
      jsailsConfig.includes(
        '...(process.env.BASE_URL ? { publicOrigin: process.env.BASE_URL } : {})',
      ),
    );
    // The override is conditional: BASE_URL never hardcodes a public origin.
    assert.ok(!jsailsConfig.includes('publicOrigin: "'));
    assert.ok(!jsailsConfig.includes("publicOrigin: '"));
  });

  it('never references SECRET_KEY_BASE nor assigns JSAILS_COMPONENT_SECRET', () => {
    const { dockerfile, jsailsConfig } = generateOnceConfig();

    // The wrapper must not read ONCE's SECRET_KEY_BASE: JSails core never
    // consumes it. Signed server components read JSAILS_COMPONENT_SECRET from
    // the environment directly, so the wrapper must not assign or reference it.
    assert.ok(!dockerfile.includes('SECRET_KEY_BASE'));
    assert.ok(!jsailsConfig.includes('SECRET_KEY_BASE'));
    assert.ok(!dockerfile.includes('JSAILS_COMPONENT_SECRET'));
    assert.ok(!jsailsConfig.includes('JSAILS_COMPONENT_SECRET'));
  });

  it('emits a .dockerignore excluding build output, dependencies, data, and secrets', () => {
    const { dockerignore } = generateOnceConfig();

    for (const entry of [
      'node_modules',
      'dist',
      'public/assets',
      'out',
      'storage',
      '.git',
      'test-results',
      'playwright-report',
      '.env',
      '.env.*',
    ]) {
      assert.ok(dockerignore.split('\n').includes(entry), `missing .dockerignore entry: ${entry}`);
    }
  });

  it('honors a custom base image in both stages', () => {
    const { dockerfile } = generateOnceConfig({ baseImage: 'node:22-bookworm-slim' });

    assert.ok(dockerfile.includes('FROM node:22-bookworm-slim AS builder'));
    assert.ok(dockerfile.includes('FROM node:22-bookworm-slim AS runtime'));
    assert.ok(!dockerfile.includes('node:24-bookworm-slim'));
  });

  it('rejects invalid options safely', () => {
    assert.throws(() => generateOnceConfig(null as unknown as OnceConfigOptions), OnceConfigError);
    assert.throws(() => generateOnceConfig([] as unknown as OnceConfigOptions), OnceConfigError);
    assert.throws(() => generateOnceConfig({ baseImage: '' }), OnceConfigError);
    assert.throws(
      () => generateOnceConfig({ baseImage: 42 as unknown as string }),
      OnceConfigError,
    );
    // Control characters and shell metacharacters cannot break out of the image ref.
    assert.throws(
      () => generateOnceConfig({ baseImage: 'node:24\nRUN rm -rf /' }),
      OnceConfigError,
    );
    assert.throws(() => generateOnceConfig({ baseImage: 'node:24; RUN evil' }), OnceConfigError);
  });
});
