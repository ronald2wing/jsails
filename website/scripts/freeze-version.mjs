#!/usr/bin/env node
/**
 * Freeze a docs version (Docusaurus `docs:version` equivalent).
 *
 * Copies the current `content/docs/` tree into `content/versions/<minor>/` and
 * updates `content/versions.json` so the frozen version is published. Runs at
 * minor-release time (NOT on patch releases). It never deletes content; re-run
 * with the same version overwrites that version's frozen tree.
 *
 * Usage: node website/scripts/freeze-version.mjs <minor>
 *   minor = numeric minor label, e.g. "1.1"
 */

import { cpSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const websiteRoot = resolve(here, '..');
const contentDir = resolve(websiteRoot, 'content');
const docsDir = resolve(contentDir, 'docs');
const versionsDir = resolve(contentDir, 'versions');
const manifestPath = resolve(contentDir, 'versions.json');

const minor = process.argv[2];
if (!minor || !/^\d+\.\d+$/.test(minor)) {
  console.error('Usage: node website/scripts/freeze-version.mjs <minor> (e.g. 1.1)');
  process.exit(1);
}

if (!existsSync(docsDir)) {
  console.error('content/docs/ does not exist; nothing to freeze.');
  process.exit(1);
}

// Copy the live docs into the frozen tree (overwrite = re-freeze).
mkdirSync(versionsDir, { recursive: true });
cpSync(docsDir, resolve(versionsDir, minor), { recursive: true });

// Update versions.json: newest first, `current` = the newest released minor.
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const versions = [minor, ...manifest.versions.filter((v) => v !== minor)];
writeFileSync(manifestPath, `${JSON.stringify({ current: minor, versions }, null, 2)}\n`);

console.log(`Frozen docs ${minor} → content/versions/${minor}/`);
console.log(`versions.json now: ${versions.join(', ')} (current: ${minor})`);
