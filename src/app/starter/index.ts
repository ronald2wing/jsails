/**
 * Starter scaffold generator.
 *
 * `createStarterFiles` produces the complete file set for a fresh JSails
 * starter application as an in-memory map of portable relative paths to file
 * contents. The implementation is split across three modules, each owning one
 * concern:
 *
 * - `files.ts` — template whitelists, variant resolution, option
 *   validation, bundled-file reading, and file-map assembly;
 * - `guides.ts` — the pure `AGENTS.md` guide text builders;
 * - `package-json.ts` — the generated `package.json` rewriting and
 *   dependency/script injection.
 *
 * This barrel re-exports the public surface unchanged. No template is ever
 * executed: `package.json.template` is JSON-parsed and re-stringified, and
 * every other template is copied verbatim as text.
 */

export { createStarterFiles, StarterError } from './files.js';
export type { StarterFiles, StarterOptions } from './files.js';
