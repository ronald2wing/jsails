/**
 * Logging: a record-first structured logging service.
 *
 * This barrel exports the core types, errors, formatters, channels, the logger
 * factory, and the first-party plugin with its service token.
 */

export { logError } from './events.js';
export { LoggerError, type LoggerErrorCode } from './errors.js';
export { consoleChannel, memoryChannel, nullChannel } from './channels.js';
export type {
  ConsoleChannelOptions,
  MemoryChannel,
  MemoryChannelOptions,
  NullChannelOptions,
} from './channels.js';
export { jsonFormatter, lineFormatter } from './formatters.js';
export { createLogger, type LoggerOptions } from './logger.js';
export { loggerPlugin, loggerToken, type LoggerPluginOptions } from './plugin.js';
export type { LogChannel, LogFormatter, Logger, LogLevel, LogRecord } from './types.js';

// The `logger` factory is the subpath's default export, matching every other
// first-party plugin subpath: `plugins.use` resolves a specifier by importing
// the default export and calling it with the options tuple.
export { loggerPlugin as default } from './plugin.js';
