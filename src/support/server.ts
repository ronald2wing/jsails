// Server-only addendum barrel for jsails/support (`jsails/support/server`).
//
// Re-exports the browser-safe core and layers on the server-only namespaces
// (`Files`, `Media`, `Cookie`) plus the top-level `parseFrontmatter`/
// `serializeError` helpers. The server-only crypto conveniences (`hashSync`,
// `hmacSync`, `timingSafeEqual`) are exported under distinct names; the shared
// async `Cryptography` is a single coherent surface re-exported from
// `./cryptography.js` via `./index.js` (see `cryptography.server.ts`). This
// barrel is NOT part of the browser projection: reach it only from server code,
// and never import it statically from `./index.js`.

export * from './index.js';

export { FilesError, Files } from './files.server.js';
export type { FilesErrorCode, WriteJsonOptions, CopyOptions, GlobOptions } from './files.server.js';

export { MediaError, Media } from './media.server.js';
export type { MediaErrorCode, MediaType, ImageSize } from './media.server.js';

export { CookieError, Cookie } from './cookie.server.js';
export type {
  CookieErrorCode,
  CookieParseOptions,
  CookieSerializeOptions,
  SetCookieParseOptions,
  ParsedSetCookie,
} from './cookie.server.js';

// Server-only crypto conveniences, sharing the ONE `Cryptography` namespace:
// `hashSync`/`hmacSync`/`timingSafeEqual` are the synchronous node:crypto
// additions; `Cryptography` itself is the same async surface the browser sees.
export {
  ServerCryptography,
  hashSync,
  hmacSync,
  timingSafeEqual,
  CryptographyError,
  Cryptography,
} from './cryptography.server.js';
export type {
  ServerCryptographyErrorCode,
  ServerHashAlgorithm,
  HmacAlgorithm,
} from './cryptography.server.js';

export { parseFrontmatter, serializeError } from './frontmatter.server.js';
export type { SerializedError } from './frontmatter.server.js';
