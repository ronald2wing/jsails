/**
 * Hotwire Native web groundwork — path-configuration loader.
 *
 * Server-agnostic loader that reads a {@link PathConfiguration} from `data`,
 * `file`, and `server` sources and merges them into a single frozen config.
 * The fetch implementation is injectable so the same loader works in browsers
 * and server runtimes without coupling to a specific HTTP library.
 *
 * Caching is **caller-owned** — this slice performs no caching.
 */

import { definePathConfiguration, type PathConfiguration } from './native.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The three source kinds recognised by the loader. */
export type PathConfigSourceKind = 'data' | 'file' | 'server';

/** A source descriptor: a kind and a value (JSON string or URL). */
export interface PathConfigSource {
  readonly kind: PathConfigSourceKind;
  readonly value: string;
}

/**
 * Value-free error raised by the path-configuration loader for fetch failures,
 * invalid JSON, or structural validation problems. Messages never echo the raw
 * source value or response body.
 */
export class PathConfigLoaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathConfigLoaderError';
  }
}

/** The loader handle returned by {@link createPathConfigurationLoader}. */
export interface PathConfigurationLoader {
  /**
   * Load a single source and return its validated {@link PathConfiguration}.
   *
   * - `data` / `file` — `value` is parsed as JSON and validated.
   * - `server` — `value` is treated as a URL, fetched with the injectable
   *   `fetch`, and the response body is parsed and validated.
   */
  load(source: PathConfigSource): Promise<PathConfiguration>;

  /**
   * Load multiple sources and merge them into one {@link PathConfiguration}.
   *
   * Settings are shallow-merged (later source wins). Rules are concatenated
   * in source order — every rule from every source is included. When the
   * sources array is empty the loader returns a config with empty settings
   * and no rules.
   */
  loadAll(sources: readonly PathConfigSource[]): Promise<PathConfiguration>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const EMPTY_SETTINGS: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * Create a path-configuration loader.
 *
 * @param options.fetch  An injectable `fetch` implementation (e.g.
 *   `globalThis.fetch` in browsers, a polyfill on the server). Must conform to
 *   the WHATWG Fetch API.
 */
export function createPathConfigurationLoader(options: {
  fetch: typeof globalThis.fetch;
}): PathConfigurationLoader {
  const { fetch: fetchImpl } = options;

  async function parseSource(source: PathConfigSource): Promise<PathConfiguration> {
    const raw = await resolveSourceValue(source, fetchImpl);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PathConfigLoaderError('path configuration source is not valid JSON');
    }

    try {
      return definePathConfiguration(parsed as Parameters<typeof definePathConfiguration>[0]);
    } catch (err) {
      if (err instanceof Error) {
        throw new PathConfigLoaderError(`path configuration source is invalid: ${err.message}`);
      }
      throw new PathConfigLoaderError('path configuration source is invalid');
    }
  }

  const loader: PathConfigurationLoader = {
    async load(source: PathConfigSource): Promise<PathConfiguration> {
      validateSourceKind(source.kind);
      return parseSource(source);
    },

    async loadAll(sources: readonly PathConfigSource[]): Promise<PathConfiguration> {
      if (sources.length === 0) {
        return Object.freeze({ settings: EMPTY_SETTINGS, rules: Object.freeze([]) });
      }

      const configs = await Promise.all(sources.map((s) => parseSource(s)));
      return mergeConfigs(configs);
    },
  };

  return loader;
}

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

function validateSourceKind(kind: string): asserts kind is PathConfigSourceKind {
  const valid: ReadonlySet<string> = new Set(['data', 'file', 'server']);
  if (!valid.has(kind)) {
    throw new PathConfigLoaderError(
      `path configuration source kind must be one of "data", "file", or "server"`,
    );
  }
}

async function resolveSourceValue(
  source: PathConfigSource,
  fetchImpl: typeof globalThis.fetch,
): Promise<string> {
  if (source.kind === 'server') {
    let response: Response;
    try {
      response = await fetchImpl(source.value);
    } catch {
      throw new PathConfigLoaderError('failed to fetch path configuration from server');
    }

    if (!response.ok) {
      throw new PathConfigLoaderError(`server returned an error while fetching path configuration`);
    }

    let body: string;
    try {
      body = await response.text();
    } catch {
      throw new PathConfigLoaderError('failed to read path configuration response body');
    }

    return body;
  }

  // data / file — the value IS the JSON string.
  return source.value;
}

// ---------------------------------------------------------------------------
// Config merging
// ---------------------------------------------------------------------------

/**
 * Merge multiple validated {@link PathConfiguration} objects into one.
 *
 * Settings are shallow-merged left-to-right (later source wins). Rules are
 * concatenated in source order — every rule from every input appears in the
 * output in declaration sequence.
 */
export function mergePathConfigurations(configs: readonly PathConfiguration[]): PathConfiguration {
  return mergeConfigs(configs);
}

function mergeConfigs(configs: readonly PathConfiguration[]): PathConfiguration {
  const mergedSettings: Record<string, unknown> = {};

  for (const config of configs) {
    for (const [key, value] of Object.entries(config.settings)) {
      mergedSettings[key] = value;
    }
  }

  const mergedRules = configs.flatMap((config) => [...config.rules]);

  return Object.freeze({
    settings: Object.freeze(mergedSettings),
    rules: Object.freeze(mergedRules),
  });
}
