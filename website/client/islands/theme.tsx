/**
 * Dark-mode toggle island.
 *
 * Flips a `data-theme` attribute (`light` | `dark`) on `<html>` and persists
 * the choice to `localStorage`. On boot, reads the persisted theme so there
 * is no flash — `data-theme` is set before the first paint.
 *
 * The CSS and Shiki code blocks respond to `html[data-theme="dark"]` via CSS
 * variables; no JavaScript-driven theme recompilation is needed.
 */

import { useEffect, useState } from 'preact/hooks';

const STORAGE_KEY = 'jsails-docs-theme';
const LIGHT = 'light';
const DARK = 'dark';

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

  return (
    <button
      class="theme-toggle"
      onClick={toggle}
      aria-label={theme === DARK ? 'Switch to light mode' : 'Switch to dark mode'}
      title={theme === DARK ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {theme === DARK ? '☀' : '☾'}
    </button>
  );
}
