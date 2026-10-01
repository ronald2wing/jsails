/**
 * Portable relative path validation, shared by the deploy-generator registry and
 * the plugin archive extractor.
 *
 * A portable relative path is the single form of file path JSails lets a
 * generator or an extracted archive place on disk: it is relative, uses forward
 * slashes, and rejects absolute POSIX/UNC paths, Windows drive paths,
 * backslashes, Windows-reserved characters, empty/`.`/`..`/`__proto__`
 * segments, and control characters. Dotfiles such as `.env.example` and
 * `.kamal/secrets` are ordinary segments and are allowed. This module is pure:
 * it performs no filesystem access and throws only {@link DeploymentRegistryError}
 * with value-free messages (no input is ever echoed).
 */

/** Error raised for registry misuse or an invalid generated file map. */
export class DeploymentRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeploymentRegistryError';
  }
}

/** C0 controls plus DEL — never valid in a path. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/** A Windows drive prefix (`C:`, `C:` relative, `C:/x`). */
const WINDOWS_DRIVE = /^[A-Za-z]:/;

/** Characters Windows forbids in a file name (drive colon handled separately). */
const WINDOWS_RESERVED_CHARS = /[<>:"|?*]/;

/**
 * Reject anything that is not a portable relative file path. Deliberately
 * conservative: absolute POSIX/UNC paths, Windows drive paths, backslashes,
 * Windows-reserved characters, empty/`.`/`..`/`__proto__` segments, and
 * control characters are all refused. Dotfiles such as `.env.example` and
 * `.kamal/secrets` are ordinary segments and are allowed.
 */
export function assertPortablePath(path: string): void {
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
export function assertNoPathCollisions(paths: readonly string[]): void {
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
