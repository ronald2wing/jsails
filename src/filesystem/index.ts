/**
 * The `filesystem` subpath: a keyed blob-store `Disk` contract with a local
 * (filesystem-backed) implementation, an in-memory implementation for tests and
 * demos, and a first-party `filesystem` plugin exposing a named `FileSystem`
 * service over those disks.
 *
 * Extension surfaces:
 * - **Variants** — lazy, cached transformations of a stored source file. The
 *   caller supplies the transform function (no image library dependency).
 * - **Rich text** — a sanitized HTML value object with plain-text extraction.
 *   The caller supplies the sanitizer (JSails ships no HTML parser).
 *
 * The public surface is deliberately narrow: `DiskError`, the `Disk`/`FileSystem`
 * contracts, the two disk factories, and the plugin with its token. The shared
 * key/option validators are module-internal (used across the implementation
 * modules) and are not re-exported here.
 */

export {
  DiskError,
  type Disk,
  type DiskData,
  type DiskErrorCode,
  type DiskPutOptions,
} from './disk.js';

export { createLocalDisk, type LocalDiskOptions } from './local-disk.js';

export { createMemoryDisk, type MemoryDiskOptions } from './memory-disk.js';

export {
  filesystemPlugin,
  filesystemToken,
  type FileSystem,
  type FilesystemPluginOptions,
} from './plugin.js';

// The declarative loader calls `mod.default(options)`, so every first-party
// subpath barrel must default-export its factory alongside the named export.
export { filesystemPlugin as default } from './plugin.js';

export {
  defineVariant,
  createVariantResolver,
  VariantError,
  type VariantDef,
  type VariantDescriptor,
  type VariantErrorCode,
  type VariantResolver,
  type VariantResolverOptions,
  type VariantTransform,
} from './variants.js';

export {
  createRichText,
  type RichText,
  type RichTextFactory,
  type RichTextOptions,
} from './rich-text.js';
