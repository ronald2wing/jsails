#!/usr/bin/env node
/**
 * Docs↔implementation correctness gate.
 *
 * Verifies that every named import and subpath specifier the docs teach actually
 * exists in the framework: subpath names are checked against `package.json`
 * `exports`, and named-exports within a `jsails`/`jsails/<subpath>` import are
 * checked against the compiled barrel's exported symbols. Any documented symbol
 * or subpath that does not exist fails the build (value-free: names only).

 * Usage: node website/scripts/check-docs.mjs
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const docsDir = resolve(repoRoot, 'website', 'content', 'docs');
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
const exportsMap = packageJson.exports ?? {};

// --- Resolve a barrel to the set of symbol names it exports, following
//     `export * from '...'` star re-exports transitively (the root barrel does
//     this heavily, so a naive grep of the compiled file misses real exports). ---

const resolvedBarrels = new Map();

function collectExportedNames(importPath, seen = new Set()) {
  const abs = resolve(repoRoot, importPath);
  if (!existsSync(abs) || seen.has(abs)) return new Set();
  if (resolvedBarrels.has(abs)) return resolvedBarrels.get(abs);
  seen.add(abs);

  const text = readFileSync(abs, 'utf8');
  const names = new Set();

  // Direct named exports: `export { a, b }`, `export const/function/class X`.
  for (const m of text.matchAll(/export\s+(?:const|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)[0]
        .trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }

  // Star re-exports: follow them transitively.
  const starRe = /export\s*\*\s*from\s*['"]([^'"]+)['"]/g;
  for (const sm of text.matchAll(starRe)) {
    const rel = resolve(dirname(abs), sm[1]);
    for (const n of collectExportedNames(rel, seen)) names.add(n);
  }

  resolvedBarrels.set(abs, names);
  return names;
}

// --- Collect doc import statements (jsails / jsails/<subpath> named imports) ---

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e.endsWith('.md')) out.push(p);
  }
  return out;
}

const files = walk(docsDir);
const violations = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  // Match `import { a, b } from 'jsails...'` inside code fences/blocks.
  const importRe = /import\s*\{([^}]+)\}\s*from\s*['"](jsails(?:\/[a-z-]*)?)['"]/g;
  for (const m of text.matchAll(importRe)) {
    const specifier = m[2];
    const names = m[1]
      .split(',')
      .map((n) => n.trim().replace(/\s+as\s+.+$/, ''))
      .filter(Boolean);

    // Subpath must exist in package.json exports.
    const subpathKey = specifier === 'jsails' ? '.' : `./${specifier.slice('jsails/'.length)}`;
    if (!(subpathKey in exportsMap)) {
      violations.push(`${file}: unknown subpath "${specifier}"`);
      continue;
    }
    // Named exports must exist in the compiled barrel.
    const entry = exportsMap[subpathKey];
    const importPath =
      typeof entry === 'string' ? entry : (entry?.import ?? entry?.default ?? null);
    if (!importPath) continue; // can't resolve — skip symbol check
    const absEntry = resolve(repoRoot, importPath);
    if (!existsSync(absEntry)) {
      violations.push(
        `${file}: "(${specifier})" barrel not built (${importPath}) — run a build first`,
      );
      continue;
    }
    const barrelText = readFileSync(absEntry, 'utf8');
    const exportedNames = collectExportedNames(absEntry);
    for (const name of names) {
      if (name.startsWith('type ')) continue; // type-only imports not symbol-checked here
      const clean = name.replace(/^type\s+/, '');
      if (!exportedNames.has(clean)) {
        violations.push(`${file}: "${clean}" not exported from "${specifier}"`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Docs reference symbols/subpaths that do not match the implementation:\n');
  for (const v of violations) console.error(`  - ${v}`);
  console.error(`\n${violations.length} mismatch(es). Fix the docs or the exports.`);
  process.exit(1);
}

console.log(`check-docs: ${files.length} doc pages validated against package exports — OK.`);
