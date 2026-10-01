/**
 * Bounded deploy-generator registry.
 *
 * This module is a neutral container: it names deploy generators, lets callers
 * register their own, and validates the shape of the file map a generator
 * returns. It never writes files, never touches `node:fs`/`node:child_process`,
 * never opens a socket, and never runs Docker, SSH, or `kamal`. The consuming
 * application owns all actual writing, symlink checks, and deployment — the
 * output here is a proposal, not a scaffold and not a deployment.
 *
 * A generator is a plain object `{ name, generate(input, context?) }` whose
 * `generate` returns (or resolves to) `{ files }`, an object mapping portable
 * relative file paths to file contents. The registry copies that map into a
 * frozen, prototype-free record after validating every path.
 */

import { BUILTIN_DEPLOYMENT_GENERATORS } from './builtin-generators.js';

/** A generated set of files: portable relative path -> file contents. */
export interface DeploymentFileMap {
  readonly files: Readonly<Record<string, string>>;
}

/**
 * Optional per-call context. Generators that do not need it may ignore it; the
 * registry always passes it through as the second argument.
 */
export interface DeploymentGeneratorContext {
  /** Cooperative cancellation signal. */
  readonly signal?: AbortSignal;
}

/**
 * A named deploy generator. `input` is generator-specific; built-in wrappers
 * accept a plain object and defer field validation to the underlying
 * generator, so an unknown adapter can define its own input shape.
 */
export interface DeploymentGenerator<Input = unknown> {
  readonly name: string;
  generate(
    input: Input,
    context?: DeploymentGeneratorContext,
  ): DeploymentFileMap | Promise<DeploymentFileMap>;
}

/** The registry surface returned by {@link createDeploymentGeneratorRegistry}. */
export interface DeploymentGeneratorRegistry {
  /** Register a generator. Throws on an invalid or already-used name. */
  register(generator: DeploymentGenerator<unknown>): void;
  /** Registered names, in deterministic registration order. */
  list(): readonly string[];
  /** Look up and run a generator, validating the returned file map. */
  generate(
    name: string,
    input?: unknown,
    context?: DeploymentGeneratorContext,
  ): Promise<DeploymentFileMap>;
}

/** Options for {@link createDeploymentGeneratorRegistry}. */
export interface DeploymentGeneratorRegistryOptions {
  /**
   * Seed the registry with the four built-in adapters. Defaults to `true`; set
   * to `false` for a custom-only registry.
   */
  includeBuiltins?: boolean;
  /** Additional generators, registered after the built-ins. */
  generators?: readonly DeploymentGenerator<unknown>[];
}

/** Error raised for registry misuse or an invalid generated file map. */
export class DeploymentRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeploymentRegistryError';
  }
}

/** Generator names are lower-case, start with a letter/digit, then `._-`. */
const GENERATOR_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** C0 controls plus DEL — never valid in a path. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/** A Windows drive prefix (`C:`, `C:` relative, `C:/x`). */
const WINDOWS_DRIVE = /^[A-Za-z]:/;

/** Characters Windows forbids in a file name (drive colon handled separately). */
const WINDOWS_RESERVED_CHARS = /[<>:"|?*]/;

/** Whether a value is a plain object (object literal or null-prototype). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Reject anything that is not a portable relative file path. Deliberately
 * conservative: absolute POSIX/UNC paths, Windows drive paths, backslashes,
 * Windows-reserved characters, empty/`.`/`..`/`__proto__` segments, and
 * control characters are all refused. Dotfiles such as `.env.example` and
 * `.kamal/secrets` are ordinary segments and are allowed.
 */
function assertPortablePath(path: string): void {
  if (path.length === 0) {
    throw new DeploymentRegistryError('generated file paths must not be empty');
  }
  if (CONTROL_CHARS.test(path)) {
    throw new DeploymentRegistryError('generated file paths must not contain control characters');
  }
  if (path.includes('\\')) {
    throw new DeploymentRegistryError(
      'generated file paths must use forward slashes, not backslashes',
    );
  }
  if (path.startsWith('/')) {
    throw new DeploymentRegistryError('generated file paths must be relative, not absolute');
  }
  if (WINDOWS_DRIVE.test(path)) {
    throw new DeploymentRegistryError(
      'generated file paths must not include a Windows drive or UNC prefix',
    );
  }
  if (WINDOWS_RESERVED_CHARS.test(path)) {
    throw new DeploymentRegistryError(
      'generated file paths must not contain Windows-reserved characters',
    );
  }
  for (const segment of path.split('/')) {
    if (segment.length === 0) {
      throw new DeploymentRegistryError('generated file paths must not contain empty segments');
    }
    if (segment === '.' || segment === '..') {
      throw new DeploymentRegistryError(
        'generated file paths must not contain "." or ".." segments',
      );
    }
    if (segment === '__proto__') {
      throw new DeploymentRegistryError(
        'generated file paths must not contain a "__proto__" segment',
      );
    }
  }
}

/**
 * Reject a path that is used as both a file and a directory. `a` and `a/b`
 * cannot coexist: writing both is impossible and one would overwrite the
 * other. The check is prefix-based at segment boundaries.
 */
function assertNoPathCollisions(paths: readonly string[]): void {
  const files = new Set(paths);
  for (const path of paths) {
    const segments = path.split('/');
    let prefix = '';
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]!;
      prefix = prefix.length === 0 ? segment : `${prefix}/${segment}`;
      if (files.has(prefix)) {
        throw new DeploymentRegistryError(
          'generated files contain a path used as both a file and a directory',
        );
      }
    }
  }
}

/**
 * Validate a generator result and copy it into a frozen, prototype-free file
 * map. Values are never echoed in error messages, so a non-string value cannot
 * leak credentials or output contents.
 */
function normalizeResult(result: unknown, generatorName: string): DeploymentFileMap {
  if (!isPlainObject(result) || !isPlainObject(result['files'])) {
    throw new DeploymentRegistryError(
      `deployment generator "${generatorName}" must return { files: { ... } }`,
    );
  }

  const source = result['files'];
  const files: Record<string, string> = Object.create(null);
  for (const path of Object.getOwnPropertyNames(source)) {
    assertPortablePath(path);
    const value = source[path];
    if (typeof value !== 'string') {
      throw new DeploymentRegistryError(
        `deployment generator "${generatorName}" produced a non-string file value`,
      );
    }
    files[path] = value;
  }

  assertNoPathCollisions(Object.getOwnPropertyNames(files));
  return Object.freeze({ files: Object.freeze(files) });
}

function assertGeneratorName(name: string): string {
  if (!GENERATOR_NAME_PATTERN.test(name)) {
    throw new DeploymentRegistryError('deployment generator names must match [a-z0-9][a-z0-9._-]*');
  }
  return name;
}

class DeploymentGeneratorRegistryImpl implements DeploymentGeneratorRegistry {
  private readonly generators = new Map<string, DeploymentGenerator<unknown>>();

  register(generator: DeploymentGenerator<unknown>): void {
    const candidate = generator as unknown as Record<string, unknown> | null | undefined;
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      typeof candidate['name'] !== 'string' ||
      typeof candidate['generate'] !== 'function'
    ) {
      throw new DeploymentRegistryError(
        'a deployment generator must be an object with a string name and a generate function',
      );
    }

    const name = assertGeneratorName(candidate['name']);
    if (this.generators.has(name)) {
      throw new DeploymentRegistryError(
        `a deployment generator named "${name}" is already registered`,
      );
    }
    this.generators.set(name, generator);
  }

  list(): readonly string[] {
    return [...this.generators.keys()];
  }

  async generate(
    name: string,
    input?: unknown,
    context?: DeploymentGeneratorContext,
  ): Promise<DeploymentFileMap> {
    const generator = this.generators.get(name);
    if (generator === undefined) {
      throw new DeploymentRegistryError(`no deployment generator registered under "${name}"`);
    }
    const result = await generator.generate(input, context);
    return normalizeResult(result, name);
  }
}

/**
 * Create a deploy-generator registry. Built-in adapters are included by
 * default; pass `{ includeBuiltins: false }` for a custom-only registry. A
 * custom generator whose name matches a built-in is rejected rather than
 * silently overriding it.
 */
export function createDeploymentGeneratorRegistry(
  options: DeploymentGeneratorRegistryOptions = {},
): DeploymentGeneratorRegistry {
  if (!isPlainObject(options)) {
    throw new DeploymentRegistryError('registry options must be a plain object');
  }
  const includeBuiltins = options.includeBuiltins ?? true;
  const custom = options.generators ?? [];
  if (!Array.isArray(custom)) {
    throw new DeploymentRegistryError('registry options.generators must be an array');
  }

  const registry = new DeploymentGeneratorRegistryImpl();
  if (includeBuiltins) {
    for (const generator of BUILTIN_DEPLOYMENT_GENERATORS) registry.register(generator);
  }
  for (const generator of custom) registry.register(generator);
  return registry;
}

/**
 * Type-preserving constructor for a custom generator. The name is validated
 * when the generator is registered, not here.
 */
export function defineDeploymentGenerator<Input = unknown>(
  name: string,
  generate: (
    input: Input,
    context?: DeploymentGeneratorContext,
  ) => DeploymentFileMap | Promise<DeploymentFileMap>,
): DeploymentGenerator<Input> {
  return { name, generate };
}
