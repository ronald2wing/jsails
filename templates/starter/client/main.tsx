/**
 * Browser entry for the starter.
 *
 * Registers the `counter` island once and starts the shared client runtime,
 * which hydrates every `data-jsails-island` element in the document (including
 * `#counter-root`) and owns navigation. There is no manual `hydrate`, `fetch`,
 * or `history` call here — the runtime owns all of that.
 *
 * A startup failure is reported once with a fixed message and leaves no state
 * behind; the server-rendered markup stays usable without hydration.
 */

import { registerIsland, startClient, type IslandProps } from 'jsails/client';

import '../ui/styles.css';
import { Counter, INITIAL_COUNT } from '../ui/counter.js';

// The island boundary hands components untyped JSON props, while `Counter`
// takes a typed `initial`. Adapt once here and fall back to the SSR default so
// the first client render matches the server markup.
registerIsland('counter', ({ initial }: IslandProps) => (
  <Counter initial={typeof initial === 'number' ? initial : INITIAL_COUNT} />
));

startClient().catch((error: unknown) => {
  console.error('jsails: client startup failed', error);
});
