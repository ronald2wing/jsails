/**
 * `build:meta` — the pre-`tsc` codegen step.
 *
 * Walks the authoring tree once (via {@link scanProjectMeta}) and writes the
 * generated artifacts under `.jsails/`: the ambient autoload declarations, the
 * autoload JSON the Vite transform consumes, and the model/component registries
 * `tsc` compiles. It runs **before** `tsc` so the declarations exist when the
 * type checker runs and the registries are part of the compiled output.
 *
 * The command takes no app config: it is a pure source-to-source transform over
 * the project tree, so it is early-routed (like `make:*`) and never loads the
 * heavy dispatch graph. `--dir <path>` relocates the project root (defaults to
 * the current working directory).
 */

import { resolve } from 'node:path';

import { scanProjectMeta } from '../build/meta-scan.js';
import { writeMetaArtifacts } from '../build/generate-meta.js';

import { formatError } from '../internal/errors.js';

/** Options for {@link runMetaCommand}. */
export interface MetaCommandOptions {
  /** Project root to scan. Defaults to the current working directory. */
  readonly dir?: string;
}

/**
 * Run the `build:meta` step. Returns 0 on success, 1 on a scan/write failure.
 * The failure message is value-free: a scan error carries no source text.
 */
export async function runMetaCommand(options: MetaCommandOptions = {}): Promise<number> {
  const rootDir = resolve(options.dir ?? process.cwd());
  try {
    const meta = await scanProjectMeta(rootDir);
    writeMetaArtifacts(meta, rootDir);
    console.log(
      `Generated .jsails/ (${meta.models.length} model(s), ${meta.components.length} component(s)).`,
    );
    return 0;
  } catch (error) {
    console.error(`jsails build:meta: ${formatError(error)}`);
    return 1;
  }
}
