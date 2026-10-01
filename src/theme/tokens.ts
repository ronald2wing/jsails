/**
 * Theme token contract: the cross-surface CSS-custom-property vocabulary shared
 * by the admin renderer, the generated starter, and plugin authors.
 *
 * This module is browser-safe: it imports nothing from `node:*` and performs no
 * I/O, so the starter UI and any client-side code can import token names without
 * dragging in the framework runtime.
 *
 * The contract has two parts:
 *
 * - A **fixed core set** of token names (`--jsails-bg`, `--jsails-fg`,
 *   `--jsails-accent`, `--jsails-muted`, `--jsails-border`) that the admin
 *   renderer and the starter layout reference directly. These names are
 *   semver-visible API.
 * - An **open `--jsails-*` namespace**: any CSS custom property whose name
 *   follows the `--jsails-<name>` pattern may be contributed and is emitted,
 *   but only the core set is guaranteed to be consumed by every surface.
 *
 * ## Resolution model
 *
 * Themes are `{ name?, tokens }` descriptors folded in ordered precedence
 * (lowest → highest):
 *
 * 1. Implicit empty base `{}`.
 * 2. Unnamed contributions, in registration order (spread-overwrite).
 * 3. The **active** named theme's effective tokens, when `options.active`
 *    names one (spread-overwrite).
 * 4. Application tokens (highest precedence — spread-overwrite).
 *
 * Two contributions sharing the same `name` are spread-merged
 * (`...earlier, ...later`), so a later contribution overrides earlier keys
 * without error. Named themes are resolved independently of the active theme
 * and every named theme's effective map is available through
 * {@link ThemeResolution.themes} for per-theme `[data-theme]` blocks.
 */

/** CSS custom properties are serialized verbatim into `<style>` tags. */
export type ThemeTokenMap = Readonly<Record<string, string>>;

/**
 * Public, versioned token names the admin renderer and the starter layout
 * actually consume. Each entry is the full CSS custom-property name
 * (e.g. `--jsails-bg`), not a bare key. Frozen so consumers can iterate
 * or index by identity.
 */
export const coreThemeTokenNames: readonly string[] = Object.freeze([
  '--jsails-bg',
  '--jsails-fg',
  '--jsails-accent',
  '--jsails-muted',
  '--jsails-border',
]);

/**
 * A plugin's static contribution: pure declarative data, no I/O.
 * Transported through {@link PluginDescription.theme} for discovery,
 * collected by the extension runner, and fed to the theme plugin.
 */
export interface ThemeContribution {
  /** Plugin or extension name, used in diagnostics. */
  readonly source: string;
  /** CSS custom properties this plugin contributes. */
  readonly tokens: ThemeTokenMap;
  /**
   * When set, this contribution belongs to a **named theme**.
   * Multiple contributions sharing the same `name` are spread-merged
   * (later overrides earlier), never rejected. Named themes participate
   * in the ordered fold when {@link resolveThemeTokens} is called with
   * an `active` option referencing their name.
   */
  readonly name?: string;
}

/**
 * Value-free assembly/injection error. The only code is `'invalid_token'`
 * (a token value containing a control character or `</style`).
 */
export class ThemeError extends Error {
  readonly code: 'invalid_token';

  constructor(code: 'invalid_token', message: string) {
    super(message);
    this.name = 'ThemeError';
    this.code = code;
  }
}

/**
 * The fully resolved theme surface returned by {@link resolveThemeTokens}.
 */
export interface ThemeResolution {
  /** The active theme's merged token map (the fold result). */
  readonly active: ThemeTokenMap;
  /** Every named theme's effective token map, keyed by name. */
  readonly themes: Readonly<Record<string, ThemeTokenMap>>;
  /** The name of the active theme, or `undefined` when none was selected. */
  readonly activeName: string | undefined;
}

/**
 * The resolved token surface consumers read. Returned by
 * {@link createThemeTokens} and provided as a service under
 * {@link themeToken}.
 */
export interface ThemeTokens {
  /** The frozen, merged token map for the active theme. */
  resolve(): ThemeTokenMap;
  /** All CSS: `:root { active }` then one `[data-theme="<name>"] { ... }` per named theme. */
  toCss(): string;
  /** Every named theme's effective token map, keyed by name. */
  themes(): Readonly<Record<string, ThemeTokenMap>>;
  /** The name of the active theme, or `undefined`. */
  activeName(): string | undefined;
}

// ---------------------------------------------------------------------------
// Seed derivation
// ---------------------------------------------------------------------------

/** Input for {@link deriveThemeTokens} — a brand color plus optional radius. */
export interface ThemeSeed {
  /** A CSS color string (hex, rgb(), hsl(), or named). */
  readonly primary: string;
  /** Optional border-radius value (e.g. `0.5rem`). Defaults to `0.375rem`. */
  readonly radius?: string;
}

/**
 * Parse a hex color (`#rgb` or `#rrggbb`) into `{ h, s, l }` in [0,1].
 * Returns `null` for non-hex values.
 */
function parseHexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex);
  if (!match) return null;
  const v = match[1]!;
  let r: number, g: number, b: number;
  if (v.length === 3) {
    r = parseInt(v[0]! + v[0], 16);
    g = parseInt(v[1]! + v[1], 16);
    b = parseInt(v[2]! + v[2], 16);
  } else {
    r = parseInt(v.substring(0, 2), 16);
    g = parseInt(v.substring(2, 4), 16);
    b = parseInt(v.substring(4, 6), 16);
  }
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rf:
        h = ((gf - bf) / d + (gf < bf ? 6 : 0)) / 6;
        break;
      case gf:
        h = ((bf - rf) / d + 2) / 6;
        break;
      case bf:
        h = ((rf - gf) / d + 4) / 6;
        break;
    }
  }
  return { h, s, l };
}

/** Convert `{ h, s, l }` back to `#rrggbb`. */
function hslToHex(h: number, s: number, l: number): string {
  const hueToRgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hueToRgb(p, q, h + 1 / 3);
    g = hueToRgb(p, q, h);
    b = hueToRgb(p, q, h - 1 / 3);
  }
  const toHex = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Derive the five core theme tokens (`--jsails-bg`, `--jsails-fg`,
 * `--jsails-accent`, `--jsails-muted`, `--jsails-border`) from a seed
 * color. The `primary` becomes `--jsails-accent` verbatim; the remaining
 * tokens are derived via HSL lightness/saturation steps when the primary
 * is a hex color, or set to sensible neutral defaults otherwise.
 *
 * The optional `radius` becomes `--jsails-radius`.
 */
export function deriveThemeTokens(seed: ThemeSeed): ThemeTokenMap {
  const { primary, radius } = seed;

  if (typeof primary !== 'string' || primary.length === 0) {
    throw new ThemeError('invalid_token', 'primary must be a non-empty string');
  }
  if (CONTROL_CHARS.test(primary)) {
    throw new ThemeError('invalid_token', 'primary must not contain control characters');
  }

  const tokens: Record<string, string> = {};
  tokens['--jsails-accent'] = primary;

  const hsl = parseHexToHsl(primary);
  if (hsl) {
    tokens['--jsails-bg'] = hslToHex(hsl.h, Math.max(0, hsl.s - 0.3), 0.97);
    tokens['--jsails-fg'] = hslToHex(hsl.h, Math.max(0, hsl.s - 0.2), 0.1);
    tokens['--jsails-muted'] = hslToHex(hsl.h, Math.max(0, hsl.s - 0.35), 0.94);
    tokens['--jsails-border'] = hslToHex(hsl.h, Math.max(0, hsl.s - 0.35), 0.88);
  } else {
    tokens['--jsails-bg'] = '#ffffff';
    tokens['--jsails-fg'] = '#1f2937';
    tokens['--jsails-muted'] = '#f3f4f6';
    tokens['--jsails-border'] = '#e5e7eb';
  }

  if (radius !== undefined) {
    tokens['--jsails-radius'] = radius;
  }

  return Object.freeze(tokens);
}

// ---------------------------------------------------------------------------
// Resolution (ordered fold)
// ---------------------------------------------------------------------------

/**
 * Fold contributions into a {@link ThemeResolution} via ordered
 * spread-overwrite:
 *
 *   1. Implicit empty base `{}`.
 *   2. Unnamed contributions, in registration order.
 *   3. The active named theme's effective tokens (when `options.active`
 *      names one).
 *   4. Application tokens (highest precedence).
 *
 * Every step is `Object.assign()` — later wins per key, no error.
 *
 * Every named theme's effective tokens (from folding all same-named
 * contributions) land in `themes` regardless of whether it is active.
 *
 * @param app - Application-level token overrides (highest precedence).
 * @param contributions - Plugin contributions in deterministic order.
 * @param options - `active` selects which named theme to fold in step 3.
 * @returns A frozen {@link ThemeResolution}.
 */
export function resolveThemeTokens(
  app: ThemeTokenMap,
  contributions: readonly ThemeContribution[],
  options?: { active?: string },
): ThemeResolution {
  // Phase 1: partition contributors into named and unnamed, folding same-named.
  const namedMaps = new Map<string, Record<string, string>>();
  const unnamed: Record<string, string>[] = [];

  for (const c of contributions) {
    if (c.name !== undefined) {
      const existing = namedMaps.get(c.name);
      if (existing) {
        // Same-name spread-merge: later wins per key.
        Object.assign(existing, c.tokens);
      } else {
        namedMaps.set(c.name, { ...c.tokens });
      }
    } else {
      unnamed.push({ ...c.tokens });
    }
  }

  // Phase 2: build per-named-theme effective maps (frozen).
  const themes: Record<string, ThemeTokenMap> = {};
  for (const [name, tokens] of namedMaps) {
    themes[name] = Object.freeze(tokens);
  }

  // Phase 3: build the active fold.
  const result: Record<string, string> = {};

  // Step 2: unnamed contributions in order.
  for (const u of unnamed) {
    Object.assign(result, u);
  }

  // Step 3: active named theme, when selected.
  const activeName = options?.active;
  if (activeName !== undefined) {
    const effective = themes[activeName];
    if (effective !== undefined) {
      Object.assign(result, effective);
    }
    // Missing active name is harmless — it is not an error in the new model.
  }

  // Step 4: app tokens (highest precedence).
  Object.assign(result, app);

  return {
    active: Object.freeze(result),
    themes: Object.freeze(themes),
    activeName,
  };
}

/**
 * Build the resolved token surface. Pure: resolves eagerly and exposes
 * the result through {@link ThemeTokens}.
 */
export function createThemeTokens(
  app: ThemeTokenMap,
  contributions: readonly ThemeContribution[],
  options?: { active?: string },
): ThemeTokens {
  const resolution = resolveThemeTokens(app, contributions, options);
  return {
    resolve() {
      return resolution.active;
    },
    toCss() {
      return themeTokensToCss(resolution);
    },
    themes() {
      return resolution.themes;
    },
    activeName() {
      return resolution.activeName;
    },
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const STYLE_BREAK = /<\/style/i;

/**
 * Serialize a {@link ThemeResolution} into a full CSS string:
 * `:root { active tokens }` followed by one `[data-theme="<name>"] { ... }`
 * block per named theme.
 *
 * Returns `''` when there are no tokens in the active map and no named
 * themes. Values are injected verbatim; a control character or `</style`
 * raises a {@link ThemeError} with code `'invalid_token'`.
 */
export function themeTokensToCss(resolution: ThemeResolution): string {
  const blocks: string[] = [];

  // :root block for active tokens.
  const rootDecls = tokenMapDeclarations(resolution.active);
  if (rootDecls.length > 0) {
    blocks.push(`:root { ${rootDecls.join(' ')} }`);
  }

  // Per-theme [data-theme] blocks (sorted for deterministic output).
  const names = Object.keys(resolution.themes).sort();
  for (const name of names) {
    const tokens = resolution.themes[name]!;
    const decls = tokenMapDeclarations(tokens);
    if (decls.length > 0) {
      blocks.push(`[data-theme="${name}"] { ${decls.join(' ')} }`);
    }
  }

  return blocks.join(' ');
}

/** Validate and join a token map into CSS declaration strings. */
function tokenMapDeclarations(tokens: ThemeTokenMap): string[] {
  const declarations: string[] = [];
  for (const [name, value] of Object.entries(tokens)) {
    if (typeof name !== 'string' || typeof value !== 'string') {
      throw new ThemeError('invalid_token', 'theme token names and values must be strings');
    }
    if (CONTROL_CHARS.test(value) || STYLE_BREAK.test(value)) {
      throw new ThemeError(
        'invalid_token',
        `theme token value for "${name}" is not safe for injection`,
      );
    }
    declarations.push(`${name}: ${value};`);
  }
  return declarations;
}
