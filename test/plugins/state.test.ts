import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PluginStateError,
  PluginStateStore,
  PLUGIN_STATE_FILENAME,
  PLUGIN_STATE_VERSION,
  type PluginState,
  type PluginStateFs,
} from '../../src/plugins/state-store.js';

/** An in-memory filesystem facade that records every write for assertions. */
function memoryFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const fs: PluginStateFs = {
    readFileSync(path) {
      const data = files.get(path);
      if (data === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return data;
    },
    writeFileSync(path, data) {
      files.set(path, data);
    },
    renameSync(from, to) {
      const data = files.get(from);
      if (data === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      files.delete(from);
      files.set(to, data);
    },
    mkdirSync() {},
  };
  return { fs, files };
}

const STATE_PATH = `/virtual/plugins/${PLUGIN_STATE_FILENAME}`;

function validState(): PluginState {
  return {
    version: PLUGIN_STATE_VERSION,
    plugins: {
      acme: { active: '1.2.3', enabled: true },
      tasks: { active: '2.0.0', enabled: false },
    },
  };
}

describe('PluginStateStore.load', () => {
  it('yields empty state when the file is missing', () => {
    const { fs } = memoryFs();
    const store = new PluginStateStore({ pluginsDir: '/virtual/plugins', fs });
    assert.deepEqual(store.load(), {
      version: PLUGIN_STATE_VERSION,
      plugins: {},
    });
  });

  it('reads and validates a populated state file', () => {
    const { fs } = memoryFs({ [STATE_PATH]: JSON.stringify(validState()) });
    const store = new PluginStateStore({ pluginsDir: '/virtual/plugins', fs });
    assert.deepEqual(store.load(), validState());
  });

  it('rejects a file that is not valid JSON', () => {
    const { fs } = memoryFs({ [STATE_PATH]: 'not json' });
    const store = new PluginStateStore({ pluginsDir: '/virtual/plugins', fs });
    assert.throws(() => store.load(), PluginStateError);
  });

  it('rejects a wrong version without echoing the value', () => {
    const { fs } = memoryFs({
      [STATE_PATH]: JSON.stringify({ version: 2, plugins: {} }),
    });
    const store = new PluginStateStore({ pluginsDir: '/virtual/plugins', fs });
    assert.throws(
      () => store.load(),
      (error: unknown) => error instanceof PluginStateError && !error.message.includes('2'),
    );
  });

  it('rejects an invalid plugin id without echoing it', () => {
    const state = {
      version: 1,
      plugins: { 'Bad!': { active: '1.0.0', enabled: true } },
    };
    const { fs } = memoryFs({ [STATE_PATH]: JSON.stringify(state) });
    const store = new PluginStateStore({ pluginsDir: '/virtual/plugins', fs });
    assert.throws(
      () => store.load(),
      (error: unknown) => error instanceof PluginStateError && !error.message.includes('Bad!'),
    );
  });

  it('rejects an invalid active version without echoing it', () => {
    const state = {
      version: 1,
      plugins: { acme: { active: 'not-a-version', enabled: true } },
    };
    const { fs } = memoryFs({ [STATE_PATH]: JSON.stringify(state) });
    const store = new PluginStateStore({ pluginsDir: '/virtual/plugins', fs });
    assert.throws(
      () => store.load(),
      (error: unknown) =>
        error instanceof PluginStateError && !error.message.includes('not-a-version'),
    );
  });

  it('rejects unknown top-level and per-plugin fields', () => {
    const state = {
      version: 1,
      plugins: { acme: { active: '1.0.0', enabled: true, extra: true } },
      bonus: true,
    };
    const { fs } = memoryFs({ [STATE_PATH]: JSON.stringify(state) });
    const store = new PluginStateStore({ pluginsDir: '/virtual/plugins', fs });
    assert.throws(() => store.load(), PluginStateError);
  });

  it('treats a non-ENOENT read failure as a state error', () => {
    const { fs } = memoryFs();
    fs.readFileSync = () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    };
    const store = new PluginStateStore({ pluginsDir: '/virtual/plugins', fs });
    assert.throws(() => store.load(), PluginStateError);
  });
});

describe('PluginStateStore.save', () => {
  it('writes atomically via a temp file and rename, then reloads', () => {
    const { fs, files } = memoryFs();
    const store = new PluginStateStore({ pluginsDir: '/virtual/plugins', fs });

    store.save(validState());

    assert.equal(files.has(`${STATE_PATH}.tmp`), false, 'temp file must be renamed away');
    assert.deepEqual(JSON.parse(files.get(STATE_PATH)!), validState());
    assert.deepEqual(store.load(), validState());
  });

  it('overwrites an existing state file', () => {
    const { fs } = memoryFs({ [STATE_PATH]: JSON.stringify(validState()) });
    const store = new PluginStateStore({ pluginsDir: '/virtual/plugins', fs });

    const next: PluginState = {
      version: PLUGIN_STATE_VERSION,
      plugins: { acme: { active: '2.0.0', enabled: true } },
    };
    store.save(next);

    assert.deepEqual(JSON.parse(fs.readFileSync(STATE_PATH)), next);
  });

  it('rejects an invalid state before writing anything', () => {
    const { fs, files } = memoryFs();
    const store = new PluginStateStore({ pluginsDir: '/virtual/plugins', fs });

    assert.throws(
      () =>
        store.save({
          version: 1,
          plugins: { 'Bad!': { active: '1.0.0', enabled: true } },
        }),
      PluginStateError,
    );
    assert.equal(files.size, 0, 'no file may be written for invalid state');
  });

  it('round-trips a settings object on the entry', () => {
    const { fs } = memoryFs();
    const store = new PluginStateStore({ pluginsDir: '/virtual/plugins', fs });

    const state: PluginState = {
      version: PLUGIN_STATE_VERSION,
      plugins: {
        acme: {
          active: '1.2.3',
          enabled: true,
          settings: { retries: 3, verbose: true, name: 'demo', opaque: { nested: [1, 2] } },
        },
      },
    };
    store.save(state);

    assert.deepEqual(store.load(), state);
  });

  it('accepts an entry without settings and loads it without a settings key', () => {
    const { fs } = memoryFs();
    const store = new PluginStateStore({ pluginsDir: '/virtual/plugins', fs });

    const state: PluginState = {
      version: PLUGIN_STATE_VERSION,
      plugins: { acme: { active: '1.2.3', enabled: true } },
    };
    store.save(state);

    const loaded = store.load();
    assert.equal(Object.hasOwn(loaded.plugins['acme']!, 'settings'), false);
  });

  it('rejects a non-object settings value', () => {
    const { fs } = memoryFs({
      [STATE_PATH]: JSON.stringify({
        version: 1,
        plugins: { acme: { active: '1.0.0', enabled: true, settings: 'not-an-object' } },
      }),
    });
    const store = new PluginStateStore({ pluginsDir: '/virtual/plugins', fs });
    assert.throws(() => store.load(), PluginStateError);
  });
});
