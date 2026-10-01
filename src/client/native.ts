/**
 * Hotwire Native web groundwork: path-configuration matching and native-bridge
 * detection for the browser client runtime.
 *
 * The path-configuration contract mirrors the Hotwire Native iOS
 * `PathConfiguration` (`{ settings?, rules: [{ patterns, properties }] }`),
 * adapted to a first-match-rule semantics that is simpler and deterministic for
 * the web side. Every rule carries an array of regex patterns; the FIRST rule
 * whose any pattern matches the URL path returns its properties. Unmatched URLs
 * receive the frozen empty default `{}`.
 *
 * The bridge layer detects two native-app markers:
 *
 * - `window.webkit.messageHandlers.bridge` — the WKWebView script-message
 *   handler contract (iOS).
 * - `window.HotwireNative.postMessage` — a framework-level singleton.
 *
 * When neither is present the bridge is a safe no-op whose `postMessage` never
 * throws, so plain-browser code can call it unconditionally.
 *
 * This module is browser-safe: it references `window` only through guard
 * expressions and imports no `node:*` runtime.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single path rule: one or more regex patterns plus a property bag. */
export interface PathRule {
  readonly patterns: readonly string[];
  readonly properties: Readonly<Record<string, unknown>>;
}

/** A frozen, validated path configuration. */
export interface PathConfiguration {
  readonly settings: Readonly<Record<string, unknown>>;
  readonly rules: readonly PathRule[];
}

/** The raw shape accepted by `definePathConfiguration`. */
export interface PathConfigurationInput {
  readonly settings?: Record<string, unknown>;
  readonly rules: ReadonlyArray<{
    readonly patterns: readonly string[];
    readonly properties: Record<string, unknown>;
  }>;
}

/**
 * A Hotwire-Native-compatible bridge handle.
 *
 * {@link postMessage} sends a named message with optional data to the native
 * layer. When no native bridge is present it is a silent no-op — callers may
 * use it unconditionally.
 */
export interface NativeBridge {
  /** Send a message to the native layer. No-op in a plain browser. */
  postMessage(name: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Value-free error thrown by {@link definePathConfiguration} for a malformed
 * or invalid path-configuration input. The message carries only structural
 * diagnostics — never the raw input.
 */
export class PathConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathConfigurationError';
  }
}

// ---------------------------------------------------------------------------
// Path configuration
// ---------------------------------------------------------------------------

const RULES_KEY = 'rules';
const SETTINGS_KEY = 'settings';
const PATTERNS_KEY = 'patterns';
const PROPERTIES_KEY = 'properties';
const MAX_RULES = 500;
const MAX_PATTERNS = 200;
const MAX_PATTERN_LENGTH = 2000;

/** The frozen empty default bag returned when no rule matches. */
const EMPTY_PROPERTIES: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * Parse and validate a Hotwire-Native-style path configuration object.
 *
 * Accepts a plain JSON-deserializable input `{ settings?, rules: [...] }` and
 * returns a deeply-frozen `PathConfiguration`. Each rule must carry a
 * non-empty `patterns` array of valid regex strings and a `properties` object.
 *
 * Rejects malformed input with a value-free {@link PathConfigurationError}.
 */
export function definePathConfiguration(input: PathConfigurationInput): PathConfiguration {
  if (input === null || typeof input !== 'object') {
    throw new PathConfigurationError('path configuration must be an object');
  }

  if (!Array.isArray(input[RULES_KEY])) {
    throw new PathConfigurationError('path configuration must have a "rules" array');
  }

  const rulesArray = input[RULES_KEY] as readonly unknown[];

  if (rulesArray.length > MAX_RULES) {
    throw new PathConfigurationError(
      `path configuration rules must not exceed ${MAX_RULES} entries`,
    );
  }

  const rules: PathRule[] = [];

  let ruleIndex = 0;
  for (const rawRule of rulesArray) {
    if (rawRule === null || typeof rawRule !== 'object') {
      throw new PathConfigurationError(`rules[${ruleIndex}] must be an object`);
    }

    const ruleObj = rawRule as Record<string, unknown>;
    const rawPatterns = ruleObj[PATTERNS_KEY];

    if (!Array.isArray(rawPatterns) || rawPatterns.length < 1) {
      throw new PathConfigurationError(
        `rules[${ruleIndex}].patterns must be a non-empty array of strings`,
      );
    }

    if (rawPatterns.length > MAX_PATTERNS) {
      throw new PathConfigurationError(
        `rules[${ruleIndex}].patterns must not exceed ${MAX_PATTERNS} entries`,
      );
    }

    const rawProperties = ruleObj[PROPERTIES_KEY];
    if (rawProperties === null || typeof rawProperties !== 'object') {
      throw new PathConfigurationError(`rules[${ruleIndex}].properties must be an object`);
    }

    // Validate every pattern as a compileable regex.
    const patterns: string[] = [];
    for (const p of rawPatterns) {
      if (typeof p !== 'string') {
        throw new PathConfigurationError(
          `rules[${ruleIndex}].patterns contains a non-string entry`,
        );
      }
      if (p.length > MAX_PATTERN_LENGTH) {
        throw new PathConfigurationError(
          `rules[${ruleIndex}].patterns contains an entry longer than ${MAX_PATTERN_LENGTH} characters`,
        );
      }
      try {
        new RegExp(p);
      } catch {
        throw new PathConfigurationError(`rules[${ruleIndex}].patterns contains an invalid regex`);
      }
      patterns.push(p);
    }

    // Shallow-freeze the properties object so callers cannot mutate it.
    const properties = Object.freeze({ ...rawProperties });

    rules.push(
      Object.freeze({
        patterns: Object.freeze(patterns),
        properties,
      }),
    );

    ruleIndex++;
  }

  const settingsInput = input[SETTINGS_KEY];
  let settings: Readonly<Record<string, unknown>>;
  if (settingsInput === undefined || settingsInput === null) {
    settings = EMPTY_PROPERTIES;
  } else if (typeof settingsInput !== 'object') {
    throw new PathConfigurationError('settings must be an object');
  } else {
    settings = Object.freeze({ ...settingsInput });
  }

  return Object.freeze({ settings, rules: Object.freeze(rules) });
}

/**
 * Resolve the merged properties for a URL against a path configuration.
 *
 * Rules are evaluated in declaration order. The **first** rule whose any
 * pattern matches the URL's path (pathname + search when the URL carries a
 * query string) contributes its properties. When no rule matches the call
 * returns the frozen empty default `{}`.
 *
 * The `url` parameter accepts a `URL` instance or a string (parsed via the
 * `URL` constructor). An invalid URL string is rejected.
 *
 * @param config  A path configuration returned by {@link definePathConfiguration}.
 * @param url     A URL instance or a string URL to match against.
 * @returns The matched rule's frozen properties, or `{}` when no rule matches.
 */
export function resolvePathConfiguration(
  config: PathConfiguration,
  url: URL | string,
): Readonly<Record<string, unknown>> {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  let path = parsed.pathname;

  // Match query strings when present (matching the native behaviour).
  if (parsed.search.length > 0) {
    path = path + parsed.search;
  }

  for (const rule of config.rules) {
    for (const pattern of rule.patterns) {
      if (new RegExp(pattern).test(path)) {
        return rule.properties;
      }
    }
  }

  return EMPTY_PROPERTIES;
}

/**
 * Resolve the merged properties for a URL against a path configuration.
 *
 * Unlike {@link resolvePathConfiguration}, which returns only the **first**
 * matching rule's properties, this resolver evaluates **every** rule and merges
 * all matching properties into the result. When two rules set the same key the
 * later rule wins (declaration-order overwrite).
 *
 * When no rule matches the call returns the frozen empty default `{}`.
 *
 * @param config  A path configuration returned by {@link definePathConfiguration}.
 * @param url     A URL instance or a string URL to match against.
 * @returns The merged properties of every matching rule, or `{}` when none match.
 */
export function resolvePathConfigurationMerged(
  config: PathConfiguration,
  url: URL | string,
): Readonly<Record<string, unknown>> {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  let path = parsed.pathname;

  if (parsed.search.length > 0) {
    path = path + parsed.search;
  }

  const merged: Record<string, unknown> = {};

  for (const rule of config.rules) {
    for (const pattern of rule.patterns) {
      if (new RegExp(pattern).test(path)) {
        for (const [key, value] of Object.entries(rule.properties)) {
          merged[key] = value;
        }
        break; // One pattern match per rule suffices.
      }
    }
  }

  if (Object.keys(merged).length > 0) {
    return Object.freeze(merged);
  }

  return EMPTY_PROPERTIES;
}

/**
 * The standard Hotwire-Native historical-location rules.
 *
 * Returns three rules in declaration order:
 *
 * 1. `recede_historical_location` — presentation `pop` with a `context` of
 *    `default`.
 * 2. `resume_historical_location` — presentation `refresh`.
 * 3. `refresh_historical_location` — presentation `replace`.
 *
 * All three set `historical_location: true` and match every path (`".*"`).
 * Application-defined rules should precede these so their properties take
 * precedence under the merged resolver.
 */
export function defaultPathRules(): PathRule[] {
  return [
    Object.freeze({
      patterns: Object.freeze(['.*']),
      properties: Object.freeze({
        presentation: 'pop',
        context: 'default',
        historical_location: true,
      }),
    }),
    Object.freeze({
      patterns: Object.freeze(['.*']),
      properties: Object.freeze({
        presentation: 'refresh',
        historical_location: true,
      }),
    }),
    Object.freeze({
      patterns: Object.freeze(['.*']),
      properties: Object.freeze({
        presentation: 'replace',
        historical_location: true,
      }),
    }),
  ];
}

// ---------------------------------------------------------------------------
// Native bridge
// ---------------------------------------------------------------------------

/**
 * Structural type of `window.webkit.messageHandlers` (present in iOS WKWebView).
 * Never imported — only used as a guard shape.
 */
interface NativeMessageHandlers {
  readonly bridge?: {
    postMessage(message: unknown): void;
  };
}

/**
 * Structural type of `window.HotwireNative` (the framework-level singleton).
 */
interface HotwireNativeGlobal {
  postMessage?(name: string, data?: Record<string, unknown>): void;
}

/**
 * Returns `true` when running inside a Hotwire Native app's web view.
 *
 * Detection is based on two well-known markers:
 *
 * - `window.webkit.messageHandlers.bridge` (iOS WKWebView)
 * - `window.HotwireNative` (framework-level singleton)
 *
 * In Node.js or a headless environment where `typeof window` is `'undefined'`
 * this returns `false` without throwing.
 */
export function isNativeApp(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const maybeWebkit = window as unknown as {
    webkit?: {
      messageHandlers?: NativeMessageHandlers;
    };
  };

  if (maybeWebkit.webkit?.messageHandlers?.bridge !== undefined) {
    return true;
  }

  const maybeHotwire = window as unknown as {
    HotwireNative?: HotwireNativeGlobal;
  };

  if (maybeHotwire.HotwireNative !== undefined) {
    return true;
  }

  return false;
}

/** Shared no-op bridge returned when no native app environment is detected. */
const NOOP_BRIDGE: NativeBridge = Object.freeze({ postMessage: () => {} });

/**
 * Returns a {@link NativeBridge} handle.
 *
 * When {@link isNativeApp} returns `true` the bridge routes `postMessage`
 * calls through `window.webkit.messageHandlers.bridge` or
 * `window.HotwireNative.postMessage`. When the native bridge is absent every
 * method is a safe no-op — callers may use the bridge unconditionally.
 *
 * In a plain browser the returned handle is a lightweight no-op object; its
 * `postMessage` never throws regardless of the native environment state.
 */
export function nativeBridge(): NativeBridge {
  if (!isNativeApp()) {
    return NOOP_BRIDGE;
  }

  const w = window as unknown as {
    webkit?: {
      messageHandlers?: NativeMessageHandlers;
    };
    HotwireNative?: HotwireNativeGlobal;
  };

  return {
    postMessage(name, data) {
      const payload = data === undefined ? { name } : { name, data };

      // Prefer the WKWebView script-message handler (iOS primary path).
      if (w.webkit?.messageHandlers?.bridge !== undefined) {
        try {
          w.webkit.messageHandlers.bridge.postMessage(payload);
        } catch {
          // The native handler may be unavailable — silently drop.
        }
        return;
      }

      // Fall back to the HotwireNative singleton.
      if (w.HotwireNative?.postMessage !== undefined) {
        try {
          w.HotwireNative.postMessage(name, data);
        } catch {
          // The native layer may refuse the call — silently drop.
        }
        return;
      }
    },
  };
}
