/**
 * Browser entry for the starter.
 *
 * Registers the `counter` island and the `theme-toggle` island once, then starts
 * the shared client runtime, which hydrates every `data-jsails-island` element
 * in the document (including `#counter-root` and `#theme-toggle-root`) and owns
 * navigation. There is no manual `hydrate`, `fetch`, or `history` call here —
 * the runtime owns all of that.
 *
 * The theme toggle is defined here rather than in `ui/` because it is pure
 * browser behavior: it flips `data-theme` on `<html>` and persists the choice
 * to localStorage. The pre-paint script in `ui/layout.tsx` already applied the
 * stored/OS theme, so the island only needs to keep the button in sync and
 * handle clicks.
 *
 * A startup failure is reported once with a fixed message and leaves no state
 * behind; the server-rendered markup stays usable without hydration.
 */

import { useEffect, useState } from 'preact/hooks';

import { registerIsland, startClient, type IslandProps } from '../app/application-client.js';

import '../ui/styles.css';
import { Counter, INITIAL_COUNT } from '../ui/counter.js';
import { RegisterForm } from '../ui/register-form.js';
import { ResetForm } from '../ui/reset-password.js';

// The island boundary hands components untyped JSON props, while `Counter`
// takes a typed `initial`. Adapt once here and fall back to the SSR default so
// the first client render matches the server markup.
registerIsland('counter', ({ initial }: IslandProps) => (
  <Counter initial={typeof initial === 'number' ? initial : INITIAL_COUNT} />
));

// The self-registration island takes no props (the form is fully server-side
// in its initial render); it only needs hydration to handle submit.
registerIsland('register-form', () => <RegisterForm />);

// The password-reset island is the same shape: no props, hydrate to submit.
registerIsland('reset-password', () => <ResetForm />);

/** localStorage key shared with the pre-paint script in `ui/layout.tsx`. */
const THEME_STORAGE_KEY = 'jsails-starter-theme';
/** daisyUI theme names for `<html data-theme=…>`; storage values stay light/dark. */
const LIGHT_THEME = 'aqua';
const DARK_THEME = 'night';

/** Read the theme currently applied to `<html>`, defaulting to light. */
function currentTheme(): string {
  return document.documentElement.getAttribute('data-theme') === DARK_THEME
    ? DARK_THEME
    : LIGHT_THEME;
}

/**
 * A compact light/dark toggle. The pre-paint script already set the attribute,
 * so this island reads it on mount and only writes on click.
 */
function ThemeToggle() {
  const [theme, setTheme] = useState(LIGHT_THEME);

  useEffect(() => {
    setTheme(currentTheme());
  }, []);

  function toggle() {
    const next = theme === DARK_THEME ? LIGHT_THEME : DARK_THEME;
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next === DARK_THEME ? 'dark' : 'light');
    } catch {
      // localStorage write denied — the toggle still works for this session.
    }
  }

  const isDark = theme === DARK_THEME;
  const label = isDark ? 'Switch to light mode' : 'Switch to dark mode';

  return (
    <button class="theme-toggle" type="button" onClick={toggle} aria-label={label} title={label}>
      <span class="theme-toggle-track" aria-hidden="true">
        <span class="theme-toggle-thumb">{isDark ? '☾' : '☀'}</span>
      </span>
    </button>
  );
}

registerIsland('theme-toggle', () => <ThemeToggle />);

startClient().catch((error: unknown) => {
  console.error('jsails: client startup failed', error);
});
