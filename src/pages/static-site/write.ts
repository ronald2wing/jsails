/**
 * Staging, ownership, and commit for {@link generateStaticSite}.
 *
 * Writes the ownership marker, rendered pages, and copied assets into a sibling
 * staging directory, then swaps it into `outDir`. Guards reject an unsafe or
 * unowned output directory before anything is written, and a failed swap
 * restores the prior output instead of deleting arbitrary paths.
 */

import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, join, parse, resolve, sep } from 'node:path';

import type { RouteManifest } from '../../routing/routes.js';
import { isErrno } from '../../internal/errors.js';
import { StaticSiteError, type PlannedPage } from './plan.js';
import type { PlannedAsset } from './public-assets.js';

/** Fixed marker proving a non-empty output directory belongs to this build. */
const MARKER_FILE = '.jsails-static-site.json';
const MARKER_CONTENTS = `${JSON.stringify({ generator: 'jsails', version: 1 })}\n`;

/** Write the ownership marker, rendered pages, and copied assets into staging. */
export function writeStaging(staging: string, pages: PlannedPage[], assets: PlannedAsset[]): void {
  writeFileSync(join(staging, MARKER_FILE), MARKER_CONTENTS);
  for (const page of pages) {
    const target = join(staging, ...page.rel.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, page.html);
  }
  for (const asset of assets) {
    const target = join(staging, ...asset.rel.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(asset.from, target);
  }
}

/**
 * Swap staging into `outDir`. An owned existing directory is moved aside first
 * and restored if the swap fails; only the moved-aside backup and staging (both
 * created here) are ever removed.
 */
export function commitStaging(staging: string, outDir: string, existed: boolean): void {
  if (!existed) {
    renameSync(staging, outDir);
    return;
  }

  const backup = uniqueSibling(outDir);
  renameSync(outDir, backup);
  try {
    renameSync(staging, outDir);
  } catch (error) {
    try {
      renameSync(backup, outDir);
    } catch {
      // Restore failed: leave the backup in place rather than deleting output.
    }
    throw error;
  }
  try {
    rmSync(backup, { recursive: true, force: true });
  } catch {
    // The new output is live; a stray backup is preferable to failing the build.
  }
}

/** Return a same-parent path that does not collide with the target. */
function uniqueSibling(target: string): string {
  return join(
    dirname(target),
    `.jsails-old-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  );
}

/**
 * Confirm `outDir` is a usable target: an absent or empty directory, or a
 * non-empty one carrying the build's exact ownership marker. A regular file
 * that merely shares the marker name (foreign, forged, or truncated contents)
 * is refused. Never deletes anything.
 */
export function inspectOutput(outDir: string): boolean {
  let stat: Stats;
  try {
    stat = lstatSync(outDir);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new StaticSiteError(`output directory "${outDir}" must not be a symlink`);
  }
  if (!stat.isDirectory()) {
    throw new StaticSiteError(`output path "${outDir}" exists and is not a directory`);
  }
  if (readdirSync(outDir).length === 0) return true;

  const marker = join(outDir, MARKER_FILE);
  let markerStat: Stats;
  try {
    markerStat = lstatSync(marker);
  } catch {
    throw new StaticSiteError(
      `refusing to overwrite non-empty output directory "${outDir}" without ownership marker "${MARKER_FILE}"`,
    );
  }
  if (markerStat.isSymbolicLink() || !markerStat.isFile()) {
    throw new StaticSiteError(
      `refusing to overwrite "${outDir}": ownership marker "${MARKER_FILE}" is not a regular file`,
    );
  }
  let contents: string;
  try {
    contents = readFileSync(marker, 'utf8');
  } catch {
    throw new StaticSiteError(
      `refusing to overwrite "${outDir}": ownership marker "${MARKER_FILE}" cannot be read`,
    );
  }
  if (contents !== MARKER_CONTENTS) {
    throw new StaticSiteError(
      `refusing to overwrite "${outDir}": ownership marker "${MARKER_FILE}" is invalid or foreign`,
    );
  }
  return true;
}

/** Reject an output directory that would contain sources or the public dir. */
export function assertOutDirSafety(
  outDir: string,
  manifest: RouteManifest,
  publicDir: string | undefined,
): void {
  for (const entry of manifest.entries) {
    const file = resolve(entry.file);
    if (file === outDir || isInside(outDir, file)) {
      throw new StaticSiteError(
        `outDir "${outDir}" must not be or contain manifest module "${file}"`,
      );
    }
  }
  if (publicDir === undefined) return;
  if (publicDir === outDir || isInside(outDir, publicDir)) {
    throw new StaticSiteError(
      `outDir "${outDir}" must not equal or contain publicDir "${publicDir}"`,
    );
  }
  if (isInside(publicDir, outDir)) {
    throw new StaticSiteError(`outDir "${outDir}" must not be inside publicDir "${publicDir}"`);
  }
}

/** Reject a symlink at any existing component of the output path. */
export function assertNoSymlinkAncestors(target: string): void {
  const abs = resolve(target);
  const { root } = parse(abs);
  const segments = abs
    .slice(root.length)
    .split(sep)
    .filter((segment) => segment !== '');
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    let stat: Stats;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new StaticSiteError(`output path ancestry "${current}" is a symlink`);
    }
  }
}

/** True when `child` is strictly below directory `parent`. */
function isInside(parent: string, child: string): boolean {
  return child !== parent && child.startsWith(parent + sep);
}
