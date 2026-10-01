/**
 * Local deploy history for jamal production rollback.
 *
 * A successful `jamal deploy` records one entry into
 * `.jamal/deploys.json` in the project root — `{ service, tag, timestamp }` —
 * so a later `jamal rollback` can find the previous successful tag
 * without any remote state. The file is written atomically (temp file +
 * rename) so a crash mid-write never leaves a truncated history that a
 * rollback would misread.
 *
 * History is local and advisory: it never reaches the server and holds no
 * secret. Reading tolerates a missing file (an empty history), while malformed
 * content is rejected with a value-free {@link DeployHistoryError} — the raw
 * file bytes are never echoed.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { isErrno } from '../../internal/errors.js';
import { isPlainObject } from '../../internal/json-safe.js';

/** The history file path relative to the project root. */
export const DEPLOYS_HISTORY_PATH = '.jamal/deploys.json';

/** The single history format version; reject anything else. */
const HISTORY_VERSION = 1;

/** Control characters plus DEL — never valid in a history string. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/** Raised for a missing, unreadable, or malformed history file. Value-free. */
export class DeployHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeployHistoryError';
  }
}

/** One recorded successful deploy. */
export interface DeployHistoryEntry {
  readonly service: string;
  readonly tag: string;
  readonly timestamp: string;
}

/** The on-disk history document: a version plus an ordered list of entries. */
export interface DeployHistory {
  readonly version: 1;
  readonly entries: readonly DeployHistoryEntry[];
}

/** The absolute path of the history file inside `dir`. */
export function deploysHistoryFile(dir: string): string {
  return join(dir, ...DEPLOYS_HISTORY_PATH.split('/'));
}

/** An empty history (used when no file exists yet). */
export function emptyDeployHistory(): DeployHistory {
  return { version: 1, entries: [] };
}

/**
 * Read the deploy history from `dir`, resolving an empty history when the file
 * is absent. Any other read failure or a malformed document raises a
 * value-free {@link DeployHistoryError}.
 */
export async function readDeployHistory(dir: string): Promise<DeployHistory> {
  const file = deploysHistoryFile(dir);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return emptyDeployHistory();
    }
    throw new DeployHistoryError('the deploy history could not be read');
  }
  return parseDeployHistory(raw);
}

/** Parse and validate the raw document; every failure is value-free. */
function parseDeployHistory(raw: string): DeployHistory {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DeployHistoryError('the deploy history is not valid JSON');
  }
  if (!isPlainObject(parsed)) {
    throw new DeployHistoryError('the deploy history has an invalid shape');
  }
  const version = (parsed as { version?: unknown }).version;
  if (version !== HISTORY_VERSION) {
    throw new DeployHistoryError('the deploy history has an unsupported version');
  }
  const rawEntries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(rawEntries)) {
    throw new DeployHistoryError('the deploy history has an invalid shape');
  }
  const entries = rawEntries.map((entry) => {
    if (!isPlainObject(entry)) {
      throw new DeployHistoryError('the deploy history has an invalid entry');
    }
    return {
      service: assertHistoryString(entry.service),
      tag: assertHistoryString(entry.tag),
      timestamp: assertHistoryString(entry.timestamp),
    };
  });
  return { version: 1, entries };
}

/** Reject a non-string or unsafe history value without echoing it. */
function assertHistoryString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DeployHistoryError('the deploy history has an invalid entry');
  }
  if (/\s/.test(value) || CONTROL_CHARS.test(value)) {
    throw new DeployHistoryError('the deploy history has an invalid entry');
  }
  return value;
}

/**
 * Write `history` into `dir` atomically: serialize to a temp file, then rename
 * it over the destination. The parent directory is created if needed, and any
 * write failure raises a value-free {@link DeployHistoryError}.
 */
export async function writeDeployHistory(dir: string, history: DeployHistory): Promise<void> {
  const file = deploysHistoryFile(dir);
  const contents = `${JSON.stringify({ version: 1, entries: history.entries }, null, 2)}\n`;
  try {
    await mkdir(dirname(file), { recursive: true });
  } catch {
    throw new DeployHistoryError('the deploy history could not be written');
  }
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, contents, 'utf8');
    await rename(temp, file);
  } catch {
    await unlink(temp).catch(() => {});
    throw new DeployHistoryError('the deploy history could not be written');
  }
}

/** Append one entry to the history in `dir` and return the new document. */
export async function appendDeployEntry(
  dir: string,
  entry: DeployHistoryEntry,
): Promise<DeployHistory> {
  const history = await readDeployHistory(dir);
  const next: DeployHistory = { version: 1, entries: [...history.entries, entry] };
  await writeDeployHistory(dir, next);
  return next;
}
