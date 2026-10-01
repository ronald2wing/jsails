/**
 * Browser-safe image and font asset helpers (`jsails/seo`).
 *
 * These are pure, declarative attribute builders — the `next/image` /
 * `next/font` analog at the HTML level. They produce `Record<string, string>`
 * maps (for spreading onto `<img>`) and CSS strings (for `@font-face`), never
 * touching a filesystem or a network.
 *
 * No `node:*` imports: this module is safe for client-side code.
 */

// ---------------------------------------------------------------------------
// imageAttrs
// ---------------------------------------------------------------------------

/** Input for {@link imageAttrs}. */
export interface ImageAttrsInput {
  readonly src: string;
  readonly width: number;
  readonly height: number;
  readonly alt?: string;
  /**
   * When `true`, the image is above the fold: `loading="eager"` and
   * `fetchpriority="high"`. Defaults to lazy loading.
   */
  readonly priority?: boolean;
  /** A `sizes` attribute to pass through. */
  readonly sizes?: string;
  /** A `srcset` attribute to pass through. */
  readonly srcset?: string;
}

/**
 * Build a `Record<string, string>` of `<img>` attributes.
 *
 * Always includes `width` and `height` so the browser reserves space and
 * prevents layout shift (the `next/image` CLS win). Loading is lazy by
 * default; pass `priority: true` for above-the-fold images to set
 * `loading="eager"` and `fetchpriority="high"`.
 *
 * `sizes` and `srcset` pass through only when supplied. URLs are never
 * auto-generated or transformed — the caller owns every source.
 */
export function imageAttrs(input: ImageAttrsInput): Record<string, string> {
  const attrs: Record<string, string> = {
    src: input.src,
    width: String(input.width),
    height: String(input.height),
  };

  if (input.priority) {
    attrs['loading'] = 'eager';
    attrs['fetchpriority'] = 'high';
  } else {
    attrs['loading'] = 'lazy';
  }

  if (input.alt !== undefined) {
    attrs['alt'] = input.alt;
  }
  if (input.sizes !== undefined) {
    attrs['sizes'] = input.sizes;
  }
  if (input.srcset !== undefined) {
    attrs['srcset'] = input.srcset;
  }

  return attrs;
}

// ---------------------------------------------------------------------------
// fontFace
// ---------------------------------------------------------------------------

/** Input for {@link fontFace}. */
export interface FontFaceInput {
  /** The font-family name (will be quoted in the CSS output). */
  readonly family: string;
  /** One or more `url(...)` source values for the `src` descriptor. */
  readonly src: string;
  /** CSS `font-weight` value, e.g. `400`, `700`, `bold`. */
  readonly weight?: string | number;
  /** CSS `font-style` value, e.g. `normal`, `italic`. */
  readonly style?: string;
  /** CSS `font-display` value, e.g. `swap`, `block`, `fallback`, `optional`. */
  readonly display?: string;
}

/**
 * Build a `@font-face { ... }` CSS string.
 *
 * The family name is properly CSS-quoted (double-quotes with backslash escapes
 * for embedded quotes and control characters). Callers own the `src` value:
 * it is injected verbatim — typically a `url(...)` expression.
 *
 * Returns a clean, single-line block suitable for embedding in a `<style>`
 * tag or a server-rendered stylesheet.
 */
export function fontFace(input: FontFaceInput): string {
  const family = cssQuoteString(input.family);
  const parts: string[] = [`font-family:${family}`];

  parts.push(`src:${input.src}`);

  if (input.weight !== undefined) {
    parts.push(`font-weight:${String(input.weight)}`);
  }
  if (input.style !== undefined) {
    parts.push(`font-style:${input.style}`);
  }
  if (input.display !== undefined) {
    parts.push(`font-display:${input.display}`);
  }

  return `@font-face{${parts.join(';')}}`;
}

// ---------------------------------------------------------------------------
// CSS string quoting
// ---------------------------------------------------------------------------

/**
 * Quote a string for use as a CSS `<family-name>` value. The result is always
 * wrapped in double-quotes. Embedded double-quotes and backslashes are escaped;
 * control characters (U+0000–U+001F, U+007F) are replaced with a safe fallback
 * so the output is always valid CSS.
 */
function cssQuoteString(value: string): string {
  let result = '"';
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    if (ch === undefined) continue;
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x22 /* " */ || cp === 0x5c /* \\ */) {
      result += '\\';
      result += ch;
    } else if (cp <= 0x1f || cp === 0x7f) {
      // Replace control chars: CSS strings must not contain raw control chars.
      result += '\\' + cp.toString(16).padStart(4, '0') + ' ';
    } else {
      result += ch;
    }
  }
  result += '"';
  return result;
}
