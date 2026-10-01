/**
 * The `jsails` field of an npm dependency's `package.json`.
 *
 * An npm plugin self-identifies by embedding a complete manifest under its
 * `jsails` field, so `jsailsPackageFieldSchema` is {@link pluginManifestSchema}
 * by reference — the two shapes are identical and stay in lockstep.
 */

import { pluginManifestSchema } from './schema.js';

/**
 * The `jsails` field schema for an npm dependency's `package.json`. It is the
 * same shape as a bundle manifest; an npm plugin self-identifies by embedding a
 * complete manifest under its `jsails` field.
 */
export const jsailsPackageFieldSchema = pluginManifestSchema;
