// Browser-safe core barrel for jsails/support.
//
// Explicit named exports only (no `export *`): the framework-symbol catalog
// scanner enumerates a barrel's value exports by name, and a wildcard would
// make the browser-safety import-graph walk opaque. See the design doc §4.1.
//
// This barrel must stay free of `node:*` and server-only packages. The
// server addendum lives in `jsails/support/server` and is reached only through
// a dynamic import from a server-only call path, never statically from here.
//
// The surface is the eight namespace objects plus their domain error classes.
// Individual helper functions stay reachable through their namespace
// (`Str.slug`, `Num.bytes`) rather than as bare barrel exports: several names
// (`add`, `compact`, `format`, `limit`, `parse`, `subtract`) exist in two
// namespaces, and a barrel cannot re-export two same-named symbols. Each
// concept module still exports its functions individually for tree-shaking.

export { StrError, Str } from './strings.js';
export { NumError, Num, type FormatMoneyOptions } from './numbers.js';
export { TimeError, Time, type TimeUnit, type DateInput } from './time.js';
export { ArrError, Arr } from './collections.js';
export {
  AsyncError,
  Async,
  type DebounceOptions,
  type ThrottleOptions,
  type RetryOptions,
  type MapConcurrentOptions,
} from './async.js';
export { EncodingError, Encoding, type DataUrlParts } from './encoding.js';
export { UrlError, Url, type QsOptions } from './urls.js';
export { CryptographyError, Cryptography, type HashAlgorithm } from './cryptography.js';
