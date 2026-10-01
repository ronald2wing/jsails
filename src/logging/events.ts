/**
 * Logging events: signal tokens shared between the logger and observers.
 *
 * Each token is defined once here using {@link defineEvent} — tokens are
 * identity-based, so two callers that separately call `defineEvent('logError')`
 * produce distinct tokens that will never match. Consumers must import the
 * shared token from `jsails/logging`.
 */

import { defineEvent, type EventToken } from '../extensions/interceptors.js';
import type { LogRecord } from './types.js';

/** Emitted for every `error`-level record when a signal bus is wired. */
export const logError: EventToken<LogRecord> = defineEvent<LogRecord>('logError');
