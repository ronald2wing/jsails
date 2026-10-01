import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ConvertComponentError, planCombine, planSplit } from '../compiler/component-shape.js';
import type { SplitPlan } from '../compiler/component-shape.js';

function printHelp() {
  console.log(
    'jsails convert:component <name>\n\nOptions:\n  --sfc  Convert to single-file component\n  --mfc  Convert to multi-file component\n  --dir <path>\n  -h, --help',
  );
}
function printUsage() {
  console.log('Usage: jsails convert:component <name> [--sfc|--mfc] [--dir <path>]');
}
function printError(m: string): void {
  console.error('jsails convert:component: ' + m);
}

function resolveShape(compDir: string, kebab: string): string {
  const sfcPath = path.join(compDir, kebab + '.tsx');
  const mfcDir = path.join(compDir, kebab);
  const mfcEntry = path.join(mfcDir, 'index.tsx');
  const hasSfc = existsSync(sfcPath);
  const hasMfcDir = existsSync(mfcDir) && existsSync(mfcEntry);
  if (hasSfc && hasMfcDir) return 'ambiguous';
  if (hasSfc) return 'sfc';
  if (hasMfcDir) return 'mfc';
  return 'none';
}

/* ------------------------------------------------------------------ */
/*  runConvertCommand                                                  */
/* ------------------------------------------------------------------ */

export async function runConvertCommand(args: readonly string[]): Promise<number> {
  const parsed = parseFlags(args);
  if (parsed.showHelp) {
    printHelp();
    return 0;
  }

  const target = parsed.sfc ? ('sfc' as const) : parsed.mfc ? ('mfc' as const) : undefined;
  const dir = parsed.dir ?? '.';
  const compDir = path.resolve(dir, 'components');
  const kebab = parsed.name;

  const shape = resolveShape(compDir, kebab);
  const result = resolveDirection(shape, target);

  if (result.kind === 'refuse') {
    return 1;
  }

  if (result.direction === 'to_mfc') {
    return convertToMfc(compDir, kebab);
  } else {
    return convertToSfc(compDir, kebab);
  }
}

/* ------------------------------------------------------------------ */
/*  Flag parsing                                                       */
/* ------------------------------------------------------------------ */

const HELP_REGEX = /^(-h|--help)$/;
const DIR_FLAG = '--dir';

interface ParsedFlags {
  name: string;
  sfc: boolean;
  mfc: boolean;
  showHelp: boolean;
  dir?: string;
}

function parseFlags(args: readonly string[]): ParsedFlags {
  const flags: ParsedFlags = { name: '', sfc: false, mfc: false, showHelp: false };

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (HELP_REGEX.test(arg)) {
      flags.showHelp = true;
      return flags;
    }
    if (arg === '--sfc') {
      flags.sfc = true;
    } else if (arg === '--mfc') {
      flags.mfc = true;
    } else if (arg === DIR_FLAG) {
      i++;
      if (i < args.length && args[i] !== undefined) {
        flags.dir = args[i];
      }
    } else if (!arg.startsWith('-')) {
      if (flags.name === '') {
        flags.name = arg;
      }
    }
    i++;
  }

  if (flags.name === '') {
    printUsage();
    return { ...flags, showHelp: false };
  }

  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(flags.name)) {
    printError('invalid component name: ' + flags.name);
    printUsage();
    return { ...flags, showHelp: false };
  }

  return flags;
}

/* ------------------------------------------------------------------ */
/*  Direction resolution                                               */
/* ------------------------------------------------------------------ */

type DirectionResult = { kind: 'refuse' } | { kind: 'convert'; direction: 'to_mfc' | 'to_sfc' };

function resolveDirection(shape: string, target: 'sfc' | 'mfc' | undefined): DirectionResult {
  if (shape === 'none') {
    printError('no component found - expected a .tsx file or directory');
    process.exitCode = 1;
    return { kind: 'refuse' };
  }

  if (shape === 'ambiguous') {
    printError('both a .tsx file and a directory sibling exist - ambiguous shape');
    process.exitCode = 1;
    return { kind: 'refuse' };
  }

  if (target === undefined) {
    const direction = shape === 'sfc' ? ('to_mfc' as const) : ('to_sfc' as const);
    return { kind: 'convert', direction };
  }

  if (shape === 'sfc' && target === 'sfc') {
    printError('component is already a single-file component');
    process.exitCode = 1;
    return { kind: 'refuse' };
  }

  if (shape === 'mfc' && target === 'mfc') {
    printError('component is already a multi-file component');
    process.exitCode = 1;
    return { kind: 'refuse' };
  }

  const direction = shape === 'sfc' ? ('to_mfc' as const) : ('to_sfc' as const);
  return { kind: 'convert', direction };
}

/* ------------------------------------------------------------------ */
/*  SFC -> MFC                                                         */
/* ------------------------------------------------------------------ */

function convertToMfc(compDir: string, kebab: string): number {
  const sfcPath = path.join(compDir, kebab + '.tsx');

  let code: string;
  try {
    code = readFileSync(sfcPath, 'utf-8');
  } catch {
    printError('cannot read component file');
    process.exitCode = 1;
    throw new ConvertComponentError('Cannot read component file', 'not_found');
  }

  let plan: SplitPlan;
  try {
    plan = planSplit(code, sfcPath);
  } catch (e) {
    if (e instanceof ConvertComponentError) {
      printError(e.message);
      process.exitCode = 1;
      return 1;
    }
    throw e;
  }

  const mfcDir = path.join(compDir, kebab);
  mkdirSync(mfcDir, { recursive: true });

  const files: Array<{ name: string; content: string | undefined }> = [
    { name: 'index.tsx', content: plan.entry },
    { name: kebab + '.model.ts', content: plan.model },
    { name: kebab + '.style.ts', content: plan.style },
    { name: kebab + '.server.ts', content: plan.server },
  ];

  for (const file of files) {
    if (file.content === undefined) continue;
    const targetPath = path.join(mfcDir, file.name);
    if (existsSync(targetPath)) {
      printError('target already exists: ' + targetPath);
      process.exitCode = 1;
      throw new ConvertComponentError('Target file already exists', 'target_exists');
    }
    writeFileSync(targetPath, file.content, 'utf-8');
  }

  unlinkSync(sfcPath);

  console.log('Converted ' + kebab + '.tsx -> ' + kebab + '/');
  console.log('  Created ' + kebab + '/index.tsx');
  if (plan.model) console.log('  Created ' + kebab + '/' + kebab + '.model.ts');
  if (plan.style) console.log('  Created ' + kebab + '/' + kebab + '.style.ts');
  if (plan.server) console.log('  Created ' + kebab + '/' + kebab + '.server.ts');

  return 0;
}

/* ------------------------------------------------------------------ */
/*  MFC -> SFC                                                         */
/* ------------------------------------------------------------------ */

function convertToSfc(compDir: string, kebab: string): number {
  const mfcDir = path.join(compDir, kebab);

  const entryPath = path.join(mfcDir, 'index.tsx');
  let entryCode: string;
  try {
    entryCode = readFileSync(entryPath, 'utf-8');
  } catch {
    printError('cannot read entry file');
    process.exitCode = 1;
    throw new ConvertComponentError('Cannot read entry file', 'missing_part');
  }

  const readOpt = (name: string): string | undefined => {
    const p = path.join(mfcDir, kebab + '.' + name + '.ts');
    try {
      return readFileSync(p, 'utf-8');
    } catch {
      return undefined;
    }
  };

  const modelCode = readOpt('model');
  const styleCode = readOpt('style');
  const serverCode = readOpt('server');

  let result: string;
  try {
    result = planCombine(
      {
        entry: entryCode,
        model: modelCode,
        style: styleCode,
        server: serverCode,
      },
      entryPath,
    );
  } catch (e) {
    if (e instanceof ConvertComponentError) {
      printError(e.message);
      process.exitCode = 1;
      return 1;
    }
    throw e;
  }

  const sfcPath = path.join(compDir, kebab + '.tsx');

  if (existsSync(sfcPath)) {
    printError('target .tsx file already exists');
    process.exitCode = 1;
    throw new ConvertComponentError('Target already exists', 'target_exists');
  }

  writeFileSync(sfcPath, result, 'utf-8');

  rmSync(mfcDir, { recursive: true });

  console.log('Converted ' + kebab + '/ -> ' + kebab + '.tsx');
  console.log('  Created ' + kebab + '.tsx');

  return 0;
}
