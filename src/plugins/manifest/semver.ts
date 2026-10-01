/**
 * Dependency-free semver (a bounded subset of the node-semver grammar).
 *
 * `parseSemver`, `isValidSemverVersion`, `isValidSemverRange`, and
 * `satisfiesRange` implement the parts of semver the plugin system needs —
 * exact, `=`, `>`, `>=`, `<`, `<=`, `^`, `~`, wildcards (`*`/`x`/`X`/
 * partials), hyphen ranges, and `||` unions — with standard version precedence
 * and the node-semver prerelease rule. This module introduces no dependency:
 * it is pure string/object manipulation.
 */

/** A parsed semantic version (build metadata is ignored). */
export interface SemverVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

const VERSION_CORE = '(0|[1-9]\\d*)';
const PRERELEASE_IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER_PATTERN = new RegExp(
  `^${VERSION_CORE}\\.${VERSION_CORE}\\.${VERSION_CORE}(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);
const PRERELEASE_IDENTIFIER_PATTERN = new RegExp(`^${PRERELEASE_IDENTIFIER}$`);
const NUMERIC_PART = /^(0|[1-9]\d*)$/;

/** Parse a full semantic version, or `null` when it is not valid semver. */
export function parseSemver(input: string): SemverVersion | null {
  if (typeof input !== 'string') return null;
  const match = SEMVER_PATTERN.exec(input);
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

/** Whether `input` is a valid semantic version. */
export function isValidSemverVersion(input: string): boolean {
  return parseSemver(input) !== null;
}

/** Whether `input` is a valid semver range (parses without error). */
export function isValidSemverRange(input: string): boolean {
  return parseRange(input) !== null;
}

/** Compare two versions: negative, zero, or positive per semver precedence. */
function compareSemver(a: SemverVersion, b: SemverVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const comparison = comparePrereleaseIdentifier(a.prerelease[i]!, b.prerelease[i]!);
    if (comparison !== 0) return comparison;
  }
  return a.prerelease.length === b.prerelease.length
    ? 0
    : a.prerelease.length < b.prerelease.length
      ? -1
      : 1;
}

function comparePrereleaseIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) {
    const na = Number(a);
    const nb = Number(b);
    return na === nb ? 0 : na < nb ? -1 : 1;
  }
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

type ComparatorOp = '' | '=' | '>' | '>=' | '<' | '<=' | '^' | '~';

/** A single comparator with wildcard-aware (nullable) components. */
interface RangeComparator {
  readonly op: ComparatorOp;
  readonly major: number | null;
  readonly minor: number | null;
  readonly patch: number | null;
  readonly prerelease: readonly string[];
}

/** A comparator set is an AND of comparators; a range is an OR of sets. */
type RangeComparatorSet = readonly RangeComparator[];

/** Half-open bounds a comparator imposes on a version. */
interface ComparatorBounds {
  readonly lo: SemverVersion | null;
  readonly loInclusive: boolean;
  readonly hi: SemverVersion | null;
  readonly hiInclusive: boolean;
}

function version(
  major: number,
  minor: number,
  patch: number,
  prerelease: readonly string[] = [],
): SemverVersion {
  return { major, minor, patch, prerelease };
}

/** Whether `version` satisfies `range` (a semver range). `false` on bad input. */
export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseSemver(version);
  if (parsed === null) return false;
  const sets = parseRange(range);
  if (sets === null) return false;
  return sets.some((set) => setSatisfies(parsed, set));
}

function parseRange(range: string): RangeComparatorSet[] | null {
  if (typeof range !== 'string' || range.trim() === '') return null;
  const sets: RangeComparatorSet[] = [];
  for (const alternative of range.split('||')) {
    const trimmed = alternative.trim();
    if (trimmed === '') return null;
    const set = parseComparatorSet(trimmed);
    if (set === null) return null;
    sets.push(set);
  }
  return sets;
}

function parseComparatorSet(set: string): RangeComparatorSet | null {
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(set);
  if (hyphen !== null) {
    const lower = parseComparator(`>=${hyphen[1]}`);
    const upper = parseComparator(`<=${hyphen[2]}`);
    if (lower === null || upper === null) return null;
    return [lower, upper];
  }
  const tokens = set.split(/\s+/).filter((token) => token !== '');
  const comparators: RangeComparator[] = [];
  for (const token of tokens) {
    const comparator = parseComparator(token);
    if (comparator === null) return null;
    comparators.push(comparator);
  }
  return comparators.length === 0 ? null : comparators;
}

function parseComparator(token: string): RangeComparator | null {
  const match = /^(<=|>=|<|>|=|\^|~)?\s*(.+)$/.exec(token);
  if (match === null) return null;
  const op = (match[1] ?? '') as ComparatorOp;
  const partial = parsePartialVersion(match[2]!);
  if (partial === null) return null;
  return { op, ...partial };
}

/** Parse a possibly wildcarded/partial version component list. */
function parsePartialVersion(str: string): {
  major: number | null;
  minor: number | null;
  patch: number | null;
  prerelease: string[];
} | null {
  let core = str;
  let prerelease: string[] = [];
  const dash = str.indexOf('-');
  if (dash !== -1) {
    core = str.slice(0, dash);
    const pre = str.slice(dash + 1);
    if (pre === '') return null;
    const identifiers = pre.split('.');
    for (const identifier of identifiers) {
      if (!PRERELEASE_IDENTIFIER_PATTERN.test(identifier)) return null;
    }
    prerelease = identifiers;
  }
  const plus = core.indexOf('+');
  if (plus !== -1) core = core.slice(0, plus);

  const parts = core.split('.');
  if (parts.length === 0 || parts.length > 3) return null;
  const components: (number | null)[] = [];
  for (const part of parts) {
    if (part === '*' || part === 'x' || part === 'X') {
      components.push(null);
      continue;
    }
    if (!NUMERIC_PART.test(part)) return null;
    components.push(Number(part));
  }
  // A wildcard may not be followed by a concrete component (`1.x.2` is invalid).
  for (let i = 0; i < components.length; i += 1) {
    if (components[i] !== null) continue;
    for (let j = i + 1; j < components.length; j += 1) {
      if (components[j] !== null) return null;
    }
  }
  return {
    major: components[0] ?? null,
    minor: components[1] ?? null,
    patch: components[2] ?? null,
    prerelease,
  };
}

function setSatisfies(parsed: SemverVersion, set: RangeComparatorSet): boolean {
  for (const comparator of set) {
    if (!comparatorSatisfies(parsed, comparator)) return false;
  }
  // node-semver's prerelease rule: a prerelease version satisfies a set only
  // when at least one comparator pins the same [major,minor,patch] tuple AND
  // carries a prerelease of its own.
  if (parsed.prerelease.length === 0) return true;
  return set.some(
    (comparator) =>
      comparator.prerelease.length > 0 &&
      comparator.major === parsed.major &&
      comparator.minor === parsed.minor &&
      comparator.patch === parsed.patch,
  );
}

function comparatorSatisfies(parsed: SemverVersion, comparator: RangeComparator): boolean {
  const bounds = comparatorBounds(comparator);
  if (bounds.lo !== null) {
    const comparison = compareSemver(parsed, bounds.lo);
    if (comparison < 0 || (comparison === 0 && !bounds.loInclusive)) return false;
  }
  if (bounds.hi !== null) {
    const comparison = compareSemver(parsed, bounds.hi);
    if (comparison > 0 || (comparison === 0 && !bounds.hiInclusive)) return false;
  }
  return true;
}

function comparatorBounds(comparator: RangeComparator): ComparatorBounds {
  const { op, major, minor, patch, prerelease } = comparator;
  switch (op) {
    case '':
    case '=': {
      if (major !== null && minor !== null && patch !== null) {
        const exact = version(major, minor, patch, prerelease);
        return { lo: exact, loInclusive: true, hi: exact, hiInclusive: true };
      }
      return {
        lo: version(major ?? 0, minor ?? 0, patch ?? 0, prerelease),
        loInclusive: true,
        hi: xRangeHigh(major, minor, patch),
        hiInclusive: false,
      };
    }
    case '^': {
      const m = major ?? 0;
      const n = minor ?? 0;
      const p = patch ?? 0;
      if (m > 0) {
        return {
          lo: version(m, n, p, prerelease),
          loInclusive: true,
          hi: version(m + 1, 0, 0),
          hiInclusive: false,
        };
      }
      if (n > 0) {
        return {
          lo: version(0, n, p, prerelease),
          loInclusive: true,
          hi: version(0, n + 1, 0),
          hiInclusive: false,
        };
      }
      return {
        lo: version(0, 0, p, prerelease),
        loInclusive: true,
        hi: version(0, 0, p + 1),
        hiInclusive: false,
      };
    }
    case '~': {
      const m = major ?? 0;
      const lo = version(m, minor ?? 0, patch ?? 0, prerelease);
      const hi = minor === null ? version(m + 1, 0, 0) : version(m, minor + 1, 0);
      return { lo, loInclusive: true, hi, hiInclusive: false };
    }
    case '>': {
      if (major === null) return emptyBounds();
      if (minor === null) {
        return {
          lo: version(major + 1, 0, 0),
          loInclusive: true,
          hi: null,
          hiInclusive: true,
        };
      }
      if (patch === null) {
        return {
          lo: version(major, minor + 1, 0),
          loInclusive: true,
          hi: null,
          hiInclusive: true,
        };
      }
      return {
        lo: version(major, minor, patch, prerelease),
        loInclusive: false,
        hi: null,
        hiInclusive: true,
      };
    }
    case '>=': {
      if (major === null) return unboundedBounds();
      return {
        lo: version(major, minor ?? 0, patch ?? 0, prerelease),
        loInclusive: true,
        hi: null,
        hiInclusive: true,
      };
    }
    case '<': {
      if (major === null) return emptyBounds();
      return {
        lo: null,
        loInclusive: true,
        hi: version(major, minor ?? 0, patch ?? 0, prerelease),
        hiInclusive: false,
      };
    }
    case '<=': {
      if (major === null) return unboundedBounds();
      if (minor === null) {
        return {
          lo: null,
          loInclusive: true,
          hi: version(major + 1, 0, 0),
          hiInclusive: false,
        };
      }
      if (patch === null) {
        return {
          lo: null,
          loInclusive: true,
          hi: version(major, minor + 1, 0),
          hiInclusive: false,
        };
      }
      return {
        lo: null,
        loInclusive: true,
        hi: version(major, minor, patch, prerelease),
        hiInclusive: true,
      };
    }
  }
}

/** The upper bound of an x-range: `1.x` -> `<2.0.0`, `*` -> unbounded. */
function xRangeHigh(
  major: number | null,
  minor: number | null,
  patch: number | null,
): SemverVersion | null {
  if (major === null) return null;
  if (minor === null) return version(major + 1, 0, 0);
  if (patch === null) return version(major, minor + 1, 0);
  return version(major, minor, patch);
}

/** No version satisfies this comparator (used for `>*` / `<*`). */
function emptyBounds(): ComparatorBounds {
  return {
    lo: version(0, 0, 0),
    loInclusive: false,
    hi: version(0, 0, 0),
    hiInclusive: false,
  };
}

/** Every version satisfies this comparator (used for `>=*` / `<=*`). */
function unboundedBounds(): ComparatorBounds {
  return { lo: null, loInclusive: true, hi: null, hiInclusive: true };
}
