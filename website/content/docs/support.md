---
title: Support Helpers
order: 27
section: Reference
---

# Support Helpers

Support helpers are a small, human-first toolkit projected as global namespaces,
so app code writes `Str.slug(title)` and `Num.bytes(size)` with no import. They
span two subpaths: a **browser-safe core** (`jsails/support`) and a **server-only
addendum** (`jsails/support/server`).

## Subpaths

| Subpath | Platform | Namespaces |
| --- | --- | --- |
| `jsails/support` | Browser-safe | `Str`, `Num`, `Time`, `Arr`, `Async`, `Encoding`, `Url`, `Cryptography` |
| `jsails/support/server` | Server-only | `Files`, `Media`, `Cookie`, `hashSync`/`hmacSync`/`timingSafeEqual` (+ shared `Cryptography`), `parseFrontmatter`, `serializeError` |

The browser-safe core never reaches `node:*` or a server-only package; the server
addendum is reached only from server code. Both are wired into the framework
symbol mechanism, so their namespaces are on `globalThis` in app code — see
[symbols.md](/docs/symbols) for how projection works.

## Usage

In app code the namespaces are already global (the CLI bootstrap installs them
before any module evaluates):

```js
// No import: these are projected globals in app code (see conventions.md).
const slug = Str.slug('Hello, World'); // 'hello-world'
const label = Num.bytes(1_500_000); // '1.5 MB'
```

Outside app scope (a plain script, a test) import the namespace instead. Every
module also exports its functions individually, so a bundler can tree-shake to
just the helper you use:

```ts
import { Str } from 'jsails/support';
import { Files } from 'jsails/support/server';
```

The barrel exports the **namespace objects and their error classes** — not the
bare functions. Several helper names (`add`, `compact`, `format`, `limit`,
`parse`, `subtract`) exist in more than one namespace, and a barrel cannot
re-export two same-named symbols. Reach an individual function through its
namespace (`Time.add`), or import it from its concept module.

## Browser-safe core

### `Str` — strings

Case transforms (`camel`, `pascal`, `snake`, `kebab`, `constant`, `title`),
`slug`, `plural`/`singular`, and hand-rolled text operations: `truncate`,
`excerpt`, `words`, `limit`, `escapeHtml`, `unescapeHtml`, `random`, `mask`.
`escapeHtml`/`unescapeHtml` cover the five HTML entities (`& < > " '`) — they are
**not** a sanitizer.

### `Num` — numbers

`format`, `compact`, `currency`, `percent`, `unit` (native `Intl.NumberFormat`),
`bytes` (`pretty-bytes`), `ordinal` (`Intl.PluralRules`), `clamp`, `round`,
`parse`, and the money pair below.

**Money is two jobs.** `Num.money(amount, currency)` returns a `dinero.js` value
object for **arithmetic** (add, subtract, multiply, allocate, compare).
`Num.formatMoney(amount, options)` renders a localized currency string for
**display** by wrapping the native `Intl.NumberFormat` — there is no maintained
money-formatting package worth adopting, so the display path is the platform
primitive plus the small gaps `Intl` does not cover (`accounting` parentheses and
an explicit `minorUnits` override). `Num.currency` is the raw `Intl.NumberFormat`
escape hatch.

```js
const total = Num.money(19.99, 'USD').multiply(3); // arithmetic
Num.formatMoney(total, { currency: 'USD' }); // '$59.97' (display)
```

### `Time` — dates & durations

`now`, `format` (native `Intl.DateTimeFormat`), `relative`
(`Intl.RelativeTimeFormat`), `duration` (`pretty-ms`), `parseDuration` (`ms`), and
`date-fns`-backed date math: `parse`, `diff`, `add`, `sub`, `startOf`, `endOf`,
`isToday`, `isPast`, `isFuture`. `TimeUnit` is
`'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'`.

### `Arr` — collections & objects

`groupBy` (native `Object.groupBy` with an `es-toolkit` fallback), `keyBy`,
`pluck`, `unique`, `uniqueBy`, `flatten`, `flattenDeep`, `compact`, `pick`,
`omit`, `get`, `set`, `has`, `sortBy`, `range`, `chunk`, `merge` (`defu`),
`clone`/`cloneDeep` (native `structuredClone`), `equals` (`fast-deep-equal`), and
`toSentence` (native `Intl.ListFormat`).

### `Async` — flow control

`sleep`/`delay`, `once`, `debounce`, `throttle`, `memoize` (`es-toolkit`),
`retry` (`p-retry`), `limit` (`p-limit`), `mapConcurrent` (`p-map`), and
`timeout` (returns a native `AbortSignal` so it composes with `fetch`).

### `Encoding` — encodings

`base64`/`base64Decode` (platform `btoa`/`atob` for text, `base64-js` for
binary), `base64url`/`base64urlDecode`, `hex`/`hexDecode`, `toDataUrl`,
`parseDataUrl`, `nanoid`, `uuid` (native `crypto.randomUUID`), `randomBytes`
(native `crypto.getRandomValues`).

### `Url` — URLs & query strings

`parseQuery`/`buildQuery` (flat, via the platform `URLSearchParams`),
`parseQueryDeep`/`buildQueryDeep` (nested, via `qs`), and `join`/`addParams`/
`removeParams` over the platform `URL` class.

### `Cryptography` — the one coherent surface

`hash`/`hmac` (native `crypto.subtle.digest`, lowercase hex), `equal`
(constant-time best-effort), `randomToken`. WebCrypto needs a **secure context**:
`hash`/`hmac` throw `insecure_context` on a non-`localhost` `http://` origin.
**MD5 and SHA-3 are not offered browser-side** — WebCrypto does not implement
them.

The **server does not shadow `Cryptography`**: it is one async surface on every
target. The server-only conveniences live under distinct names in
`jsails/support/server` (below).

## Server addendum

`jsails/support/server` re-exports the browser core and adds the server
namespaces. It is server-only and must never enter the browser bundle.

### `Files` — filesystem

`readJson`, `writeJson`, `ensureDir`, `copy`, `move`, `remove` (`fs-extra`),
`exists` (native `fs/promises`), `glob` (`fast-glob`), `rimraf`, and `toBase64`.
`writeJson` creates parent directories before writing.

### `Media` — MIME & media

`mime`/`extension` (`mime-types`), `detect` (`file-type` — sniffs a buffer's
magic bytes), `imageSize` (`image-size`).

### `Cookie` — cookies

`parse`/`serialize` (`cookie`), `parseSetCookie` (`set-cookie-parser`).

### Server-only crypto conveniences

The synchronous `node:crypto` digests are server-only **additions**, not a second
`Cryptography`:

- `hashSync(algorithm, data)` — lowercase hex for any `node:crypto` algorithm,
  including **MD5** and the **SHA-3** family (the legacy/interop hashes WebCrypto
  lacks).
- `hmacSync(algorithm, key, data)` — synchronous HMAC.
- `timingSafeEqual(a, b)` — the platform's true constant-time comparison.

`ServerCryptography` bundles these with the shared async `Cryptography` (so the
server namespace is a strict superset of the browser one). Import them directly
for legacy-interop server code:

```ts
import { hashSync } from 'jsails/support/server';

hashSync('MD5', 'abc'); // '900150983cd24fb0d6963f7d28e17f72'
```

The bare global `globalThis.Cryptography` is the **same async surface on the
server and browser** — no divergence, no namespace-key parking.

### Top-level helpers

`parseFrontmatter(input)` (`gray-matter`) returns `{ data, content }`.
`serializeError(error)` (`serialize-error`) turns an `Error` into a plain,
JSON-safe object.

## Errors

Each namespace owns a **domain error** with a stable `code` and a message that
names the operation, never the input — every `jsails/support` error is
**value-free**:

`StrError`, `NumError`, `TimeError`, `ArrError`, `AsyncError`, `EncodingError`,
`UrlError`, `CryptographyError` (browser), and the server addendum's
`FilesError`, `MediaError`, `CookieError`, plus the server `CryptographyError`.

Codes include `invalid_argument`, `unsupported_algorithm`, `insecure_context`,
`decode_failed`, `encode_failed`, `not_found`, and `io_failed`. A malformed
base64/hex input throws `EncodingError('decode_failed')` without echoing the
input; `Cryptography.equal` returns `false` on a length mismatch rather than
throwing; `parseDataUrl` returns `null` on a non-match (a parse's "no match" is a
value, not an error).

## Honest limits

- **`crypto.subtle` requires a secure context.** Browser `Cryptography.hash`/
  `hmac` throw `insecure_context` on a non-`localhost` `http://` origin — a
  platform constraint, not a JSails choice.
- **`structuredClone` limits.** `Arr.clone`/`cloneDeep` cannot clone functions,
  DOM nodes, class prototypes (methods are lost), or `WeakMap`/`WeakSet`; the
  `klona` fallback has its own (different) limits.
- **MD5 gap.** MD5 is server-only. A browser caller needing MD5 has no JSails
  helper — a deliberate non-goal.
- **Money split.** `Num.money` is arithmetic; `Num.formatMoney` is display.
  Compose them (`formatMoney(money(amount, currency), { currency })`) when you
  want both.
- **`Object.groupBy` fallback.** On Node 20, `Arr.groupBy` uses `es-toolkit`;
  the fallback is the authority on that runtime.
- **Deferred.** No locale-aware collation helper; no `Time` timezone database
  beyond `Intl`; no `Files` streaming API; no `Media` image transform (that is
  `jsails/filesystem`'s variant seam).

## Related

- [Utility Services](/docs/services) — cache, mail, filesystem, notifications,
  validation, HTTP client.
- [Symbols & Autoload](/docs/symbols) — how namespaces reach `globalThis`.
