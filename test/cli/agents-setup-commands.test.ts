/**
 * `jsails agents:setup` — emits `.mcp.json`, `AGENTS.md`, and the loadable
 * JSails skill, with exclusive creation and idempotent re-runs.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  runAgentsSetupCommand,
  type AgentsSetupDeps,
} from '../../src/cli/agents-setup-commands.js';

function depsFor(): { deps: AgentsSetupDeps; files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    deps: {
      exists: (path) => files.has(path),
      readFile: async (path) => files.get(path) ?? '',
      writeFile: async (path, content) => {
        files.set(path, content);
      },
      mkdir: async () => undefined,
      cwd: '/app',
    },
  };
}

describe('agents:setup', () => {
  it('writes all three canonical artifacts', async () => {
    const { files, deps } = depsFor();
    const code = await runAgentsSetupCommand([], deps);
    assert.equal(code, 0);
    assert.ok(files.get('/app/.mcp.json')?.includes('"jsails"'));
    assert.ok(files.get('/app/AGENTS.md')?.length !== undefined);
    assert.ok(files.get('/app/AGENTS.md')?.includes('JSails'));
    assert.ok(files.get('/app/.agents/skills/jsails/SKILL.md')?.includes('jsails_describe'));
  });

  it('merges the jsails server into an existing .mcp.json without clobbering', async () => {
    const { files, deps } = depsFor();
    files.set('/app/.mcp.json', '{"mcpServers":{"other":{"command":"x"}}}');
    await runAgentsSetupCommand([], deps);
    const parsed = JSON.parse(files.get('/app/.mcp.json')!) as {
      mcpServers: Record<string, unknown>;
    };
    assert.ok('other' in parsed.mcpServers);
    assert.ok('jsails' in parsed.mcpServers);
  });

  it('refuses to overwrite AGENTS.md without --force', async () => {
    const { files, deps } = depsFor();
    files.set('/app/AGENTS.md', 'existing');
    await runAgentsSetupCommand([], deps);
    assert.equal(files.get('/app/AGENTS.md'), 'existing');
  });

  it('--force overwrites AGENTS.md and the skill', async () => {
    const { files, deps } = depsFor();
    files.set('/app/AGENTS.md', 'old');
    files.set('/app/.agents/skills/jsails/SKILL.md', 'old-skill');
    await runAgentsSetupCommand(['--force'], deps);
    assert.notEqual(files.get('/app/AGENTS.md'), 'old');
    assert.ok(files.get('/app/.agents/skills/jsails/SKILL.md')?.includes('jsails_describe'));
  });

  it('rejects an unknown option', async () => {
    const { files, deps } = depsFor();
    const code = await runAgentsSetupCommand(['--nope'], deps);
    assert.equal(code, 2);
    void files;
  });
});
