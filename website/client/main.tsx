/**
 * Browser entry for the JSails docs site.
 *
 * Registers the `search` and `theme` islands and starts the shared client
 * runtime, which hydrates every `data-jsails-island` element in the document
 * and owns Turbo Drive navigation.
 *
 * Search is powered by Pagefind (build-time index in `out/pagefind/`).
 * A startup failure is reported once to `console.error` and leaves the
 * server-rendered markup usable (search and theme toggle degrade gracefully
 * without hydration).
 */

import { registerIsland, startClient } from 'jsails/client';

import Search from './islands/search.js';
import ThemeToggle from './islands/theme.js';
import './styles.css';

// Register the search island (Pagefind-powered, no embedded corpus needed).
registerIsland('search', () => <Search />);

// Register the theme toggle island.
registerIsland('theme', () => <ThemeToggle />);

// Start the client runtime (Turbo Drive + island hydration).
startClient().catch((error: unknown) => {
  console.error('jsails: client startup failed', error);
});
