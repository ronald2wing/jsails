import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  generateCloudflarePagesConfig,
  generateGitHubPagesConfig,
  generateNetlifyStaticConfig,
  generateVercelStaticConfig,
  HostingConfigError,
  VERCEL_CONFIG_SCHEMA,
  type CloudflarePagesOptions,
} from '../src/deploy/hosting-config.js';
import { createDeploymentGeneratorRegistry } from '../src/deploy/registry.js';
import { BUILTIN_DEPLOYMENT_GENERATOR_IDS } from '../src/deploy/builtin-generators.js';
import {
  generateCloudflarePagesConfig as publicCloudflare,
  generateGitHubPagesConfig as publicGitHub,
  generateNetlifyStaticConfig as publicNetlify,
  generateVercelStaticConfig as publicVercel,
  HostingConfigError as PublicHostingConfigError,
} from '../src/index.js';

/**
 * Tests for the static-hosting deploy generators. They assert the generated
 * config CONTENTS (exact key fields and workflow steps), that no secret is ever
 * embedded, and that the four ids are registered in the default deploy
 * registry. Nothing is written to disk or executed — every generator is a pure
 * string function.
 */

describe('generateVercelStaticConfig', () => {
  it('emits a vercel.json with the documented static-export fields', () => {
    const { vercelJson } = generateVercelStaticConfig();

    const parsed = JSON.parse(vercelJson) as Record<string, unknown>;
    assert.equal(parsed['$schema'], VERCEL_CONFIG_SCHEMA);
    assert.equal(parsed['framework'], null);
    assert.equal(parsed['buildCommand'], 'npm run build');
    assert.equal(parsed['installCommand'], 'npm ci');
    assert.equal(parsed['outputDirectory'], 'out');
    assert.equal(parsed['cleanUrls'], true);
    assert.equal(parsed['trailingSlash'], false);
  });

  it('is pure and embeds no secret', () => {
    const a = generateVercelStaticConfig();
    const b = generateVercelStaticConfig();
    assert.deepEqual(a, b);
    assert.ok(!a.vercelJson.includes('hunter2'));
  });

  it('rejects a non-plain-object options argument', () => {
    assert.throws(() => generateVercelStaticConfig([] as never), HostingConfigError);
    assert.throws(() => generateVercelStaticConfig(null as never), HostingConfigError);
  });
});

describe('generateNetlifyStaticConfig', () => {
  it('emits a netlify.toml with build command, publish dir, and pretty URLs', () => {
    const { netlifyToml } = generateNetlifyStaticConfig();

    assert.ok(netlifyToml.includes('[build]'));
    assert.ok(netlifyToml.includes('command = "npm run build"'));
    assert.ok(netlifyToml.includes('publish = "out"'));
    assert.ok(netlifyToml.includes('[build.processing.html]'));
    assert.ok(netlifyToml.includes('pretty_urls = true'));
  });

  it('is pure and embeds no secret', () => {
    const a = generateNetlifyStaticConfig();
    const b = generateNetlifyStaticConfig();
    assert.deepEqual(a, b);
    assert.ok(!a.netlifyToml.includes('hunter2'));
  });
});

describe('generateCloudflarePagesConfig', () => {
  it('emits a wrangler.toml with the project name and output directory', () => {
    const { wranglerToml } = generateCloudflarePagesConfig({ name: 'my-app' });

    assert.ok(wranglerToml.includes('name = "my-app"'));
    assert.ok(wranglerToml.includes('pages_build_output_dir = "out"'));
  });

  it('accepts the minimum and maximum valid project names', () => {
    assert.doesNotThrow(() => generateCloudflarePagesConfig({ name: 'a' }));
    assert.doesNotThrow(() => generateCloudflarePagesConfig({ name: `a${'b'.repeat(57)}` }));
  });

  it('rejects a missing or empty name', () => {
    assert.throws(
      () => generateCloudflarePagesConfig({} as CloudflarePagesOptions),
      HostingConfigError,
    );
    assert.throws(() => generateCloudflarePagesConfig({ name: '' }), HostingConfigError);
  });

  it('rejects names with invalid characters or edge hyphens', () => {
    for (const name of ['MyApp', 'my_app', '-myapp', 'myapp-', 'my app', 'my.app']) {
      assert.throws(() => generateCloudflarePagesConfig({ name }), HostingConfigError, name);
    }
  });

  it('rejects a name longer than the Cloudflare limit', () => {
    assert.throws(
      () => generateCloudflarePagesConfig({ name: `a${'b'.repeat(58)}` }),
      HostingConfigError,
    );
  });

  it('rejects a non-string name and a non-plain-object options argument', () => {
    assert.throws(
      () => generateCloudflarePagesConfig({ name: 42 as unknown as string }),
      HostingConfigError,
    );
    assert.throws(() => generateCloudflarePagesConfig(null as never), HostingConfigError);
  });
});

describe('generateGitHubPagesConfig', () => {
  it('emits the official static Pages workflow with the required steps', () => {
    const { workflow } = generateGitHubPagesConfig();

    assert.ok(workflow.includes('name: Deploy static content to Pages'));
    assert.ok(workflow.includes('uses: actions/checkout@v4'));
    assert.ok(workflow.includes('uses: actions/configure-pages@v5'));
    assert.ok(workflow.includes('uses: actions/upload-pages-artifact@v3'));
    assert.ok(workflow.includes('uses: actions/deploy-pages@v5'));
    assert.ok(workflow.includes('path: out'));
    assert.ok(workflow.includes('run: npm run build'));
  });

  it('declares permissions, concurrency, and the github-pages environment', () => {
    const { workflow } = generateGitHubPagesConfig();

    assert.ok(workflow.includes('permissions:'));
    assert.ok(workflow.includes('  contents: read'));
    assert.ok(workflow.includes('  pages: write'));
    assert.ok(workflow.includes('  id-token: write'));
    assert.ok(workflow.includes('concurrency:'));
    assert.ok(workflow.includes('  group: "pages"'));
    assert.ok(workflow.includes('environment:'));
    assert.ok(workflow.includes('      name: github-pages'));
  });

  it('emits an empty .nojekyll placeholder and no secret', () => {
    const a = generateGitHubPagesConfig();
    const b = generateGitHubPagesConfig();

    assert.deepEqual(a, b);
    assert.equal(a.nojekyll, '');
    assert.ok(!a.workflow.includes('hunter2'));
  });
});

describe('deploy registry hosting inclusion', () => {
  it('registers the four hosting ids in the default registry', () => {
    const ids = [...BUILTIN_DEPLOYMENT_GENERATOR_IDS];
    for (const id of ['vercel-static', 'netlify-static', 'cloudflare-pages', 'github-pages']) {
      assert.ok(ids.includes(id as (typeof ids)[number]), `missing builtin id ${id}`);
    }
    const registry = createDeploymentGeneratorRegistry();
    const list = registry.list();
    assert.deepEqual(list.slice(-4), [
      'vercel-static',
      'netlify-static',
      'cloudflare-pages',
      'github-pages',
    ]);
  });

  it('vercel-static maps vercel.json through the registry', async () => {
    const registry = createDeploymentGeneratorRegistry();
    const result = await registry.generate('vercel-static');
    assert.equal(result.files['vercel.json'], generateVercelStaticConfig().vercelJson);
  });

  it('netlify-static maps netlify.toml through the registry', async () => {
    const registry = createDeploymentGeneratorRegistry();
    const result = await registry.generate('netlify-static');
    assert.equal(result.files['netlify.toml'], generateNetlifyStaticConfig().netlifyToml);
  });

  it('cloudflare-pages maps wrangler.toml and validates the name', async () => {
    const registry = createDeploymentGeneratorRegistry();
    const result = await registry.generate('cloudflare-pages', { name: 'acme-site' });
    assert.equal(
      result.files['wrangler.toml'],
      generateCloudflarePagesConfig({ name: 'acme-site' }).wranglerToml,
    );
    await assert.rejects(
      registry.generate('cloudflare-pages', { name: 'Bad Name' }),
      HostingConfigError,
    );
  });

  it('github-pages maps the workflow and .nojekyll marker', async () => {
    const registry = createDeploymentGeneratorRegistry();
    const result = await registry.generate('github-pages');
    assert.equal(result.files['.github/workflows/pages.yml'], generateGitHubPagesConfig().workflow);
    assert.equal(result.files['.nojekyll'], '');
  });
});

describe('public API re-exports', () => {
  it('exposes the four generator functions and the error from the root entry', () => {
    assert.equal(publicVercel, generateVercelStaticConfig);
    assert.equal(publicNetlify, generateNetlifyStaticConfig);
    assert.equal(publicCloudflare, generateCloudflarePagesConfig);
    assert.equal(publicGitHub, generateGitHubPagesConfig);
    assert.equal(PublicHostingConfigError, HostingConfigError);
  });
});
