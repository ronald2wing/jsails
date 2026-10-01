/**
 * Theme toggle island.
 *
 * Flips a `data-theme` attribute (`aqua` | `night`) on `<html>` and persists
 * the choice to `localStorage`. On boot, reads the persisted theme so there
 * is no flash — `data-theme` is set before the first paint.
 *
 * The CSS and Shiki code blocks respond to `html[data-theme="night"]` via CSS
 * variables; no JavaScript-driven theme recompilation is needed.
 */

import { useEffect, useState } from 'preact/hooks';

const STORAGE_KEY = 'jsails-docs-theme';
const LIGHT = 'aqua';
const DARK = 'night';

/** Returns the persisted theme or the OS preference fallback. */
function getInitialTheme(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === DARK || stored === LIGHT) return stored;
  } catch {
    // localStorage unavailable (e.g. in an iframe) — use OS preference.
  }
  if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches) {
    return DARK;
  }
  return LIGHT;
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState(LIGHT);

  // Apply on mount: read persisted theme and set `data-theme`.
  useEffect(() => {
    const initial = getInitialTheme();
    setTheme(initial);
    document.documentElement.setAttribute('data-theme', initial);
  }, []);

  function toggle() {
    const next = theme === DARK ? LIGHT : DARK;
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage write denied — the toggle still works for this session.
    }
  }

  const isDark = theme === DARK;
  const label = isDark ? 'Switch to light mode' : 'Switch to dark mode';

  return (
    <button
      class="btn btn-ghost btn-sm btn-square"
      onClick={toggle}
      aria-label={label}
      title={label}
      type="button"
    >
      {isDark ? (
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}
