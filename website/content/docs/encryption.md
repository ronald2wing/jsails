---
title: Encryption
order: 25
section: Reference
---

# Encryption

Encryption covers the symmetric encryption seam and how it integrates with
models.

Encryption is meant to be used declaratively: mark a field on a model and the
framework resolves the key and wires the encrypt/decrypt hooks for you. The
low-level encrypter is the advanced surface for custom call sites and tests.
This guide is ordered that way — the declarative path first, the primitives
after.

The underlying `jsails/encryption` subpath is a symmetric **AES-256-GCM**
encrypter built on `node:crypto` — no new dependency. It is server-only and must
never enter the browser-safe `jsails/api`/`jsails/client` graphs.

## Field encryption on a model

For the compiler-driven model surface, the `@jsails.encrypts()` decorator marks
a scalar field for transparent encryption; `defineModel` wires the `encrypts()`
hook bridge using `resolveModelEncrypter()`, which reads the framework-level
key from the environment. No import or encrypter construction is needed at the
call site:

```ts
class User extends ApplicationRecord {
  @jsails.encrypts() declare email: string;
}
```

- Set `JSAILS_ENCRYPTION_KEY` to a high-entropy secret of at least 32 bytes.
- Optionally set `JSAILS_ENCRYPTION_PREVIOUS_KEYS` to a comma-separated list of
  decrypt-only keys for key rotation.

The decorator is a **compile-time marker** only: the compiler folds the field
into the model's `encrypted` list, and the runtime encryption is wired by
`defineModel` calling `encrypts(entity, resolveModelEncrypter(), fields)` — the
decorator factory itself is a no-op. When no key is configured, `defineModel`
installs a sentinel encrypter that throws a value-free `EncryptionError` on
first use, so a keyless deployment fails at the first write or read rather than
silently persisting plaintext. Migrations never invoke the hook (DDL does not
read or write rows), so a keyless migration run is unaffected.

See [Models](/docs/models) for the decorator and the compiler pipeline.

## The hook bridge

The decorator above is a thin layer over `encrypts(entity, encrypter, fields,
options?)` (from `jsails/database`). Use it directly when you are not on the
compiler-driven model surface, or when you want to supply your own encrypter.
It builds an `EntityHooksDefinition` that transparently encrypts and decrypts
the named fields at the subscriber boundary: `beforeInsert` and `beforeUpdate`
encrypt, `afterLoad` decrypts. Wire it through `createEntitySubscriber` into a
`JsailsDataSource` `subscribers` array.

`resolveModelEncrypter()` is the same environment-keyed encrypter `defineModel`
uses, so the hook-bridge path needs no key threading either:

```ts
import { encrypts, createEntitySubscriber } from 'jsails/database';
import { resolveModelEncrypter } from 'jsails/encryption';

// dataSource construction
subscribers: [
  createEntitySubscriber(encrypts(User, resolveModelEncrypter(), ['email'])),
];
```

A decrypt failure (tampered or foreign ciphertext) throws a value-free
`EncryptionError` (`decryption_failed`) — the field value is never echoed.

### Deterministic mode

The default mode uses a random IV, so equal plaintexts produce different
ciphertext and the encrypted column is **not queryable by equality**. Pass
`{ deterministic: true, deterministicKey }` to the hook bridge to opt into a
local deterministic cipher whose IV is derived from the plaintext (SHA-256 →
first 12 bytes), so equal plaintexts always yield equal ciphertext and the
column **is** queryable by equality.

```ts
encrypts(User, resolveModelEncrypter(), ['email'], {
  deterministic: true,
  deterministicKey: process.env.DET_KEY!, // required when deterministic: true
});
```

This is opt-in because equality of ciphertext leaks equality of plaintext. A
separate `deterministicKey` is required — the primary encrypter's key is never
extracted — and it uses a distinct HKDF salt for domain separation. An optional
`aad` binds extra authenticated data to every call.

Deterministic mode is available only through the hook bridge, **not** through the
`@jsails.encrypts()` decorator, which always uses the framework key
non-deterministically.

## The encrypter

The declarative paths above resolve an encrypter for you. The encrypter itself
is also a public primitive, for custom call sites, tooling, and tests — this is
the advanced surface; most applications never construct one directly.

`new AesEncrypter({ key, previousKeys? })` builds an inert adapter with
`encrypt(plaintext, { aad? })` and `decrypt(token, { aad? })`. Construction
validates keys eagerly and performs no crypto until a method is called.

`Encrypter` is an **interface** — a port, not a class. `AesEncrypter` is the
framework's implementation; the contract is any object with `encrypt`/`decrypt`,
so you can supply your own to the hook bridge
(`encrypts(User, myEncrypter, [...])`). The framework itself does this: the
keyless sentinel the model path installs is a hand-written `Encrypter` literal,
not an `AesEncrypter`. The port and the adapter are deliberately two names — the
interface keeps the domain word `Encrypter` that the rest of the surface uses
(`encrypts(entity, encrypter)`, `encryptionToken`), and the concrete adapter
carries its algorithm, exactly as the mail seam pairs `Mailer` with
`SmtpTransport`.

```ts
import { AesEncrypter } from 'jsails/encryption';

const encrypter = new AesEncrypter({ key: process.env.APP_ENCRYPTION_KEY! });

const token = encrypter.encrypt('secret message');
const plaintext = encrypter.decrypt(token); // => 'secret message'
```

The primitive takes the key explicitly — it reads no environment variable — so a
call site that constructs one must name its key.

This guide imports its framework exports explicitly. That is a deliberate choice,
not a claim that these APIs are "lower level" than the decorator:

- Project code (`app/`, `server/`, `shared/`) is auto-imported — the compiler
  scans those modules and injects the `import` for any bare identifier, so you
  write the name and never the statement.
- Framework exports (`encrypts`, `resolveModelEncrypter`, `AesEncrypter`) are
  published as globals by the server preload (`installFrameworkSymbols`, run by
  `jsails serve`/`build`/`dev`), so they *may* be bare in a served project. But
  that preload is not guaranteed — a plain script or a unit test that does not
  opt in would see a `ReferenceError`. An explicit `import` is order-independent
  and works everywhere, so a reference snippet uses it.
- `@jsails.encrypts()` is the one bare form here, for a mechanical reason: the
  decorator emits a runtime `jsails.*` expression that must resolve at
  module-evaluation time, and `ApplicationRecord` installs that namespace as a
  side effect of any model import.

See [Conventions](/docs/conventions) for the full autoload and preload model.

### Envelope

The ciphertext envelope is `v1.<iv>.<tag>.<ciphertext>`, each part base64url
(no padding). The `v1` version tag is mandatory so a future format is rejected
with `unsupported_version` rather than misparsed. The IV is 12 random bytes per
`encrypt` call (GCM-recommended) and the tag is 16 bytes.

### Key model

- A `string` key is a high-entropy secret of at least 32 bytes from which a
  32-byte AES key is derived with **HKDF-SHA256** (a fixed domain-separation
  salt; the input is a secret, not a password).
- A `Uint8Array` key is used verbatim and must be exactly 32 bytes.

Truncation is deliberately avoided: two secrets sharing a 32-byte prefix must
not collide.

### Key rotation

`previousKeys` is **decrypt-only**. `encrypt` always uses `key`, while `decrypt`
tries `key` first, then each `previousKeys` entry in order, returning the first
that authenticates. The key is never stored in the envelope, so rotation needs
no format change.

```ts
const encrypter = new AesEncrypter({
  key: currentKey,
  previousKeys: [oldKey], // still decrypts old ciphertext; never encrypts
});
```

### AAD

An optional `aad` string is bound into the GCM tag; a mismatch (or a
missing/extra `aad`) fails authentication with `decryption_failed`.

### Errors

Every failure is a value-free `EncryptionError` with one of the codes
`invalid_key`, `invalid_options`, `invalid_token`, `decryption_failed`, or
`unsupported_version`. Errors never echo the key, plaintext, ciphertext, token,
or AAD. A wrong key or tampered ciphertext yields `decryption_failed` and never
partial plaintext.

## The plugin

When an encrypter is wanted as an injectable service rather than resolved from
the environment, `encryptionPlugin(options)` provides an `Encrypter` under the
typed `encryptionToken` service token. Options pass through to the `AesEncrypter`
constructor and are validated eagerly during `setup`. Construction is inert.

```js
// jsails.app.js  (app-owned; plain ESM, compiled JS)
import { encryptionPlugin } from 'jsails/encryption';

export default {
  plugins: {
    use: [
      ['jsails/encryption', { key: process.env.APP_ENCRYPTION_KEY }],
    ],
  },
};
```

There is **no global secret** fallback in `AesEncrypter` itself, and the
`encryptionToken` service is distinct from the environment-keyed
`resolveModelEncrypter()` the model paths use — both read the same environment if
you configure them from it, but the plugin surfaces the encrypter through the
service registry for extensions that prefer injection.

## Next steps

- [Utility Services](/docs/services) — the cluster of small focused services.
- [Conventions](/docs/conventions) — the declarative model DSL and autoload layer.
