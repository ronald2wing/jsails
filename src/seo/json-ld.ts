/**
 * JSON-LD structured-data helpers (`jsails/seo`).
 *
 * `schema-dts` supplies the Google-maintained `Thing` type universe at compile
 * time (types only); at runtime {@link jsonLd} serializes a node (or an array
 * of nodes) into a `</script>`-safe payload the head builder emits as
 * `<script type="application/ld+json">`.
 */

import type { Thing } from 'schema-dts';

import { SeoError } from './errors.js';

/**
 * A structured-data node. `Thing` is a union of every schema.org type
 * (`Article`, `Organization`, `BreadcrumbList`, …) plus an escape-hatch leaf
 * for custom shapes, so a plain object literal typechecks against it.
 */
export type JsonLdNode = Thing;

/**
 * A prepared JSON-LD payload: the exact script `type` plus a
 * `</script>`-safe serialized `json` body. Produced by {@link jsonLd}.
 */
export interface JsonLdScript {
  readonly type: 'application/ld+json';
  readonly json: string;
}

/**
 * Serialize a JSON-LD node or node array into a {@link JsonLdScript}.
 *
 * The JSON is escaped so a string value containing `</script>` (or `<!--`)
 * cannot break out of the surrounding script element. The input is never
 * mutated.
 */
export function jsonLd(node: Thing | readonly Thing[]): JsonLdScript {
  return { type: 'application/ld+json', json: serializeJsonLd(node) };
}

/**
 * Serialize an arbitrary JSON-LD value to a `</script>`-safe string. Every `<`
 * becomes `\u003c`, which is invisible to a JSON consumer but prevents the
 * HTML parser from closing the script early.
 */
export function serializeJsonLd(node: unknown): string {
  const encoded = JSON.stringify(node);
  if (encoded === undefined) {
    throw new SeoError('invalid_json_ld', 'JSON-LD data could not be serialized');
  }
  return encoded.replace(/</g, '\\u003c');
}
