/**
 * Image and document variants: a lazy materialization seam over a {@link Disk}.
 *
 * A variant is a deterministic, cached transformation of a stored source file.
 * Unlike ActiveStorage's image-specific variant pipeline, JSails variants are
 * **transform-agnostic**: the caller supplies the transform function, so
 * variants can resize images, transcode audio, re-encode video, or produce
 * document thumbnails through whatever native or WASM codec the app bundles.
 *
 * The resolver owns caching: on the first `resolve` it reads the source, runs
 * the transform, and writes the result to the disk under a derived key; every
 * subsequent resolve for the same source + variant returns immediately (cache
 * hit). The derived key is a SHA-256 hex hash of `sourceKey + variantName +
 * canonical-params`, so two variants with different params produce different
 * keys and never collide.
 *
 * ## Variant key format
 *
 * Variant keys live under the `_variants/` prefix and are the hex-encoded
 * SHA-256 digest of the seed tuple. The prefix is opaque — callers address
 * variants by `(sourceKey, variantName)` and never construct keys themselves.
 *
 * ## Errors
 *
 * Every failure that reaches a caller is a value-free {@link VariantError}:
 * no key, path, variant name, or data content is ever embedded in a message.
 * A `'missing_source'` code means the source file was not on the disk;
 * `'unknown_variant'` means no variant with that name is registered;
 * `'transform_failed'` means the transform threw or rejected.
 */

import { createHash } from 'node:crypto';

import { DiskError, type Disk } from './disk.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A transform function: receives raw source bytes and the variant's static
 * params, returns transformed bytes. May be async. The transform itself has
 * **no dependency on any image or media library** — the caller supplies it.
 */
export type VariantTransform<Params extends Record<string, unknown> = Record<string, unknown>> = (
  input: Uint8Array,
  params: Params,
) => Uint8Array | Promise<Uint8Array>;

/** A named, registered variant carrying its transform and static params. */
export interface VariantDef<Params extends Record<string, unknown> = Record<string, unknown>> {
  readonly name: string;
  readonly transform: VariantTransform<Params>;
  readonly params: Params;
}

/**
 * A variant descriptor with opaque params. The resolver never inspects param
 * types — it only passes `params` to the transform and into the key hash.
 * Using `any` for the transform's params parameter keeps the resolver
 * generic-agnostic so callers can register variants with any param shape.
 */
export interface VariantDescriptor {
  readonly name: string;
  readonly transform: (input: Uint8Array, params: any) => Uint8Array | Promise<Uint8Array>;
  readonly params: Record<string, unknown>;
}

/** Options for {@link createVariantResolver}. */
export interface VariantResolverOptions {
  /** The backing disk for source files and cached variant outputs. */
  readonly disk: Disk;
  /** Registered variants keyed by name. */
  readonly variants: Record<string, VariantDescriptor>;
}

/**
 * A resolver that derives, caches, and materializes variants on a {@link Disk}.
 *
 * `resolve(sourceKey, variantName)` returns the deterministic variant key
 * after the variant is on disk (either from cache, or freshly materialized).
 * `keyFor(sourceKey, variantName)` computes the same key without any I/O or
 * materialization.
 */
export interface VariantResolver {
  /** Resolve (and lazily materialize) a variant. Returns the derived key. */
  resolve(sourceKey: string, variantName: string): Promise<string>;

  /** Compute the deterministic variant key without touching the disk. */
  keyFor(sourceKey: string, variantName: string): string;
}

/** Machine-readable reason for a {@link VariantError}. */
export type VariantErrorCode = 'unknown_variant' | 'missing_source' | 'transform_failed';

/** Raised for every variant failure that reaches a caller. Messages are value-free. */
export class VariantError extends Error {
  readonly code: VariantErrorCode;

  constructor(code: VariantErrorCode, message: string) {
    super(message);
    this.name = 'VariantError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// defineVariant
// ---------------------------------------------------------------------------

/**
 * Define a variant.
 *
 * `name` is the lookup key passed to `resolve()` / `keyFor()`.
 * `transform` is the caller-supplied transformation function — JSails ships
 * no image or media library, so the caller owns every codec decision.
 * `params` are **static** configuration values passed to the transform and
 * included in the variant-key fingerprint. Use `{}` for parameterless variants.
 *
 * The returned object is a frozen reference passed directly to
 * {@link createVariantResolver}. It performs eager validation: a missing or
 * non-string `name`, or a non-function `transform`, throws `TypeError`.
 */
export function defineVariant<Params extends Record<string, unknown> = Record<string, unknown>>(
  def: VariantDef<Params>,
): VariantDef<Params> {
  if (!def.name || typeof def.name !== 'string') {
    throw new TypeError('variant name must be a non-empty string');
  }
  if (typeof def.transform !== 'function') {
    throw new TypeError('variant transform must be a function');
  }
  return def;
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/** Serialize params to a deterministic JSON string (sorted keys, no whitespace). */
function canonicalParams(params: Record<string, unknown>): string {
  return JSON.stringify(params, Object.keys(params).sort());
}

/** Compute the deterministic variant key. */
function computeVariantKey(
  sourceKey: string,
  variantName: string,
  params: Record<string, unknown>,
): string {
  const seed = `${sourceKey}\0${variantName}\0${canonicalParams(params)}`;
  return `_variants/${createHash('sha256').update(seed).digest('hex')}`;
}

// ---------------------------------------------------------------------------
// createVariantResolver
// ---------------------------------------------------------------------------

/**
 * Create a variant resolver over a {@link Disk}.
 *
 * `resolve(sourceKey, variantName)` derives the variant key, checks the disk
 * for an existing cached output (immediate return on hit), and on a miss reads
 * the source, runs the variant's transform, writes the result to the disk, then
 * returns the key. Two resolves for the same `(sourceKey, variantName)` are
 * idempotent — the second is always a cache hit.
 *
 * `keyFor(sourceKey, variantName)` computes the same key with no disk I/O and
 * no materialization.
 *
 * A missing source throws `VariantError('missing_source', ...)`. An unregistered
 * variant name throws `VariantError('unknown_variant', ...)`. A transform that
 * throws or rejects throws `VariantError('transform_failed', ...)`. Every error
 * message is value-free — no key, path, or data content is ever surfaced.
 */
export function createVariantResolver(options: VariantResolverOptions): VariantResolver {
  const { disk, variants } = options;

  function lookup(name: string): VariantDescriptor {
    const def = variants[name];
    if (!def) {
      throw new VariantError('unknown_variant', 'unknown variant');
    }
    return def;
  }

  return {
    keyFor(sourceKey: string, variantName: string): string {
      const def = lookup(variantName);
      return computeVariantKey(sourceKey, def.name, def.params);
    },

    async resolve(sourceKey: string, variantName: string): Promise<string> {
      const def = lookup(variantName);
      const variantKey = computeVariantKey(sourceKey, def.name, def.params);

      if (await disk.exists(variantKey)) {
        return variantKey;
      }

      let source: Uint8Array;
      try {
        source = await disk.get(sourceKey);
      } catch (error) {
        if (error instanceof DiskError && error.code === 'not_found') {
          throw new VariantError('missing_source', 'source file not found');
        }
        throw error;
      }

      let result: Uint8Array;
      try {
        result = await def.transform(source, def.params);
      } catch {
        throw new VariantError('transform_failed', 'variant transform failed');
      }

      await disk.put(variantKey, result);
      return variantKey;
    },
  };
}
