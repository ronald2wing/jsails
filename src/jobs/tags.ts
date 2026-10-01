/**
 * Job tags: caller-supplied monitoring labels for job classification and
 * filtering. Tags are validated, normalized strings suitable for attaching
 * to dispatch options (via the reserved `__jsailsTags` key) or passing to
 * the metrics and failed-job store collectors.
 *
 * Every function is synchronous and value-free — errors carry only a
 * machine-readable code, never the malformed input.
 */

/** Maximum length of a single tag string. */
export const MAX_TAG_LENGTH = 64;

/** Maximum number of tags a single job may carry. */
export const MAX_TAGS = 10;

/** Reserved dispatch-option key. The value is forwarded verbatim by the queue
 * allowlist; the worker-side reader normalizes it. */
export const TAG_OPTION_KEY = '__jsailsTags';

/** Raised when a tag fails validation. The `.code` is always `'invalid_tag'`. */
export class TagError extends Error {
  readonly code = 'invalid_tag' as const;

  constructor(message: string) {
    super(message);
    this.name = 'TagError';
  }
}

/**
 * Normalize and validate an array of tag values.
 *
 * Each element must be a non-empty string of at most `MAX_TAG_LENGTH`
 * characters. The result is deduplicated, trimmed, and bounded to at most
 * `MAX_TAGS` in insertion order (first occurrence wins).
 *
 * Throws {@link TagError} (value-free) for any non-string, empty, or
 * over-length tag. Inputs that are not an array throw with code
 * `'invalid_tag'` as well.
 */
export function normalizeTags(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TagError('tags must be an array');
  }

  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of value) {
    if (typeof raw !== 'string') {
      throw new TagError('each tag must be a string');
    }
    const trimmed = raw.trim();
    if (trimmed === '') {
      throw new TagError('tags must not be empty');
    }
    if (trimmed.length > MAX_TAG_LENGTH) {
      throw new TagError(`each tag must be at most ${MAX_TAG_LENGTH} characters`);
    }

    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
      if (result.length >= MAX_TAGS) {
        break;
      }
    }
  }

  return Object.freeze(result);
}

/**
 * Build a filter predicate that checks whether an entry's tag list contains
 * every one of the requested tags.
 *
 * Returns `true` when `entryTags` is an array and a superset of the requested
 * tags. Returns `false` for missing tags, `undefined` entry-tags, or when
 * `entryTags` is not an array.
 */
export function tagFilter(
  tags: readonly string[],
): (entryTags: readonly string[] | undefined) => boolean {
  return (entryTags) => {
    if (entryTags === undefined || !Array.isArray(entryTags)) {
      return false;
    }
    return Array.prototype.every.call(tags, (t) => entryTags.includes(t));
  };
}
