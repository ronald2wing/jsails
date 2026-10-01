/**
 * Browser entry for the static blog.
 *
 * Starts the shared client runtime, which owns soft navigation through Turbo
 * Drive. There are no islands to register: a content-first blog ships no
 * per-page client state, so the browser runtime does exactly one job — turn
 * ordinary same-origin links into fast in-place navigation.
 *
 * There is no manual `hydrate`, `fetch`, or `history` call here; the runtime
 * owns navigation. A startup failure is reported once with a fixed message and
 * leaves no state behind, so the server-rendered markup stays usable.
 */

import { startClient } from '../app/application-client.js';

import '../ui/styles.css';

startClient().catch((error: unknown) => {
  console.error('jsails: client startup failed', error);
});
