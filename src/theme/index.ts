/**
 * Theme subpath: the cross-surface CSS-custom-property contract shared by the
 * admin renderer, the generated starter, and plugin authors.
 *
 * Import from `jsails/theme` for a browser-safe entry — no `node:*`
 * imports, no ORM, no HTTP. The admin renderer reads the resolved tokens
 * through {@link themeToken} (an optional service), the starter layout emits
 * them through {@link ThemeTokens.toCss} (which includes per-theme
 * `[data-theme]` blocks), and plugins contribute through
 * {@link PluginDescription.theme}.
 */

export {
  coreThemeTokenNames,
  createThemeTokens,
  deriveThemeTokens,
  resolveThemeTokens,
  themeTokensToCss,
  ThemeError,
  type ThemeContribution,
  type ThemeResolution,
  type ThemeSeed,
  type ThemeTokenMap,
  type ThemeTokens,
} from './tokens.js';

export { themePlugin, themeToken, type ThemePluginOptions } from './plugin.js';
