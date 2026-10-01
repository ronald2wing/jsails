/**
 * Minimal rich-text value object: sanitized HTML with a derived plain-text
 * representation.
 *
 * `createRichText({ sanitize })` produces a factory whose `fromHtml(html)`
 * method runs the caller-supplied sanitizer, derives a plain-text version by
 * stripping tags, and enforces a bounded input length. JSails **never** trusts
 * producer HTML and **never** ships a built-in HTML sanitizer — the caller
 * owns all sanitization and must provide a `sanitize` function.
 *
 * This module has no dependency on `node:crypto`, `jsdom`, or any HTML parser.
 * Tag-stripping for plain text uses a simple, conservative regex that removes
 * every `<...>` token and decodes the five XML named entities plus the two
 * common apostrophe numeric references. It is sufficient for display purposes
 * but is **not** a security boundary — the `sanitize` callback is the sole
 * security boundary.
 *
 * ## Usage
 *
 * ```ts
 * import { createRichText } from 'jsails/filesystem';
 *
 * const richText = createRichText({ sanitize: mySanitizer });
 * const value = richText.fromHtml('<h1>Hello</h1><script>alert(1)</script>');
 * // value.html  — what mySanitizer returned
 * // value.plain — "Hello" (tags stripped from sanitized HTML)
 * ```
 *
 * ## Security
 *
 * The `sanitize` function receives **raw, untrusted HTML** and must return a
 * safe HTML string. If the sanitizer is a pass-through (`(h) => h`), the
 * returned `html` property will contain whatever the producer supplied,
 * including `<script>` tags and event handlers. JSails performs no additional
 * sanitization. The caller is responsible for choosing a correct sanitizer.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options for {@link createRichText}. */
export interface RichTextOptions {
  /**
   * Sanitize untrusted HTML. Receives raw input and must return safe HTML.
   *
   * JSails never trusts producer HTML — this function is the **only**
   * sanitization step. Without a correct sanitizer the `html` property may
   * contain dangerous markup.
   */
  readonly sanitize: (html: string) => string;

  /**
   * Maximum length of the input HTML string before truncation (default 65536).
   * The truncation happens **before** sanitization, so an over-length input
   * is silently truncated to the first `maxLength` characters — the caller
   * should validate length independently or set this bound conservatively.
   */
  readonly maxLength?: number;
}

/** A sanitized rich-text value with HTML and plain-text representations. */
export interface RichText {
  /** The sanitized HTML returned by the `sanitize` callback. */
  readonly html: string;

  /** Sanitized HTML with tags stripped and basic entities decoded. */
  readonly plain: string;
}

/** Factory for converting raw HTML into a {@link RichText} value. */
export interface RichTextFactory {
  /** Sanitize `html` and return a {@link RichText} with `html` and `plain`. */
  fromHtml(html: string): RichText;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum input HTML length (64 KB). */
const DEFAULT_MAX_LENGTH = 65_536;

// ---------------------------------------------------------------------------
// Plain-text extraction
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags from a sanitized string and decode the five XML named
 * entities plus the two apostrophe numeric references. All other entities
 * are left as-is — they have already been through the caller's sanitizer.
 *
 * This is a display helper, not a security boundary. The input must already
 * be sanitized HTML.
 */
function stripTags(html: string): string {
  // Strip comments, CDATA sections, and every <...> tag, then decode
  // entities. The regex is deliberately simple — we assume the sanitizer
  // already stripped dangerous tags, so we only need to remove the safe
  // tags it left behind. This is a display helper, not a security boundary.
  return (
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#39;/g, "'")
      // Collapse consecutive whitespace into a single space and trim.
      .replace(/\s+/g, ' ')
      .trim()
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a rich-text factory.
 *
 * The returned factory is a lightweight object with one method: `fromHtml`.
 * Every call to `fromHtml` independently sanitizes and derives a fresh
 * `RichText` — the factory holds no state and is safe to reuse.
 *
 * Input HTML that exceeds `maxLength` (default 64 KB) is silently truncated
 * to `maxLength` characters **before** sanitization. Characters beyond the
 * bound are discarded. If the caller needs to reject over-long input instead,
 * validate the length before calling `fromHtml`.
 *
 * @throws {TypeError} if `sanitize` is not a function or `maxLength` is not
 *   a positive integer.
 */
export function createRichText(options: RichTextOptions): RichTextFactory {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;

  if (typeof options.sanitize !== 'function') {
    throw new TypeError('sanitize must be a function');
  }
  if (typeof maxLength !== 'number' || !Number.isInteger(maxLength) || maxLength < 1) {
    throw new TypeError('maxLength must be a positive integer');
  }

  return {
    fromHtml(raw: string): RichText {
      const truncated = raw.length > maxLength ? raw.slice(0, maxLength) : raw;
      const html = options.sanitize(truncated);
      const plain = stripTags(html);
      return { html, plain };
    },
  };
}
