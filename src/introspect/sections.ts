/**
 * Introspection endpoint: section definition, provider contract, and service token.
 *
 * {@link INTROSPECT_SECTIONS} is the enumerable set of sections this
 * framework version supports and is the single source the schema and the
 * built-in provider factory draw from. A {@link IntrospectProvider} owns one
 * section and returns its data as a {@link JsonValue} when asked; the route
 * assembles responses from all providers lazily, isolating each so one failure
 * never corrupts another.
 */

import type { JsonValue } from '../contracts/http.js';
import { createServiceToken } from '../extensions/services.js';
import type { RequestContext } from '../contracts/http.js';
import type { ServiceRegistry } from '../extensions/services.js';

/** Every section this framework version recognises. The schema rejects anything else. */
export const INTROSPECT_SECTIONS = [
  'routes',
  'plugins',
  'components',
  'pipeline',
  'config',
  'migrations',
  'diagnostics',
  'jobs',
  'health',
] as const;

/** A recognised introspection section name. */
export type IntrospectSection = (typeof INTROSPECT_SECTIONS)[number];

/** Per-section collection status inside the envelope. */
export type IntrospectSectionStatus = 'ok' | 'unavailable' | 'error';

/** Error detail carried when a provider fails; never includes a stack trace. */
export interface IntrospectSectionError {
  readonly code: string;
  readonly message: string;
}

/** The result object for one section inside the response envelope. */
export interface IntrospectSectionResult {
  readonly status: IntrospectSectionStatus;
  readonly data?: JsonValue;
  readonly error?: IntrospectSectionError;
}

/** A single section provider: owns one section and returns its data on demand. */
export interface IntrospectProvider {
  /** Non-empty section name, drawn from {@link INTROSPECT_SECTIONS}. */
  readonly section: IntrospectSection;
  /**
   * Collect this section's data. Receives the request context and the read-only
   * service registry the route resolved (may be undefined when no extensions
   * were applied). A provider that needs a lazily-resolved dependency reports
   * `{ status: 'unavailable' }` rather than throwing.
   */
  collect(
    context: RequestContext,
    services: ServiceRegistry | undefined,
  ): Promise<JsonValue> | JsonValue;
}

/** Service token registered with the extension system so the route can resolve providers. */
export const introspectProvidersToken =
  createServiceToken<readonly IntrospectProvider[]>('introspect-providers');
