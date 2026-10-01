/**
 * `jsails mcp` — run the MCP introspection server over stdio.
 *
 * ```sh
 * jsails mcp [--config <path>] [--db-config <path>] [--help]
 * ```
 *
 * Non-JSON-RPC output (progress, startup messages) goes to stderr.
 * Usage errors exit 2, consistent with the other early-routed commands.
 */

import { formatError, usageError as reportUsageError } from '../internal/errors.js';

/** Render usage text for `jsails mcp --help`. */
function mcpHelp(): string {
  return `mcp - start the MCP introspection server (Model Context Protocol over stdio)

Usage:
  jsails mcp [options]

Options:
  -c, --config <path>     Path to the app config module (default: jsails.app.js)
      --db-config <path>  Path to the database config module (default: jsails.config.js)
  -h, --help              Show this help

The server reads JSON-RPC on stdin and writes responses on stdout.
Every message must be one line: the transport is newline-delimited JSON.
Supported methods: initialize, ping, tools/list, tools/call.

Read-only — never writes to the filesystem, never opens a database connection.
`;
}

/**
 * Parse and run `jsails mcp` from the raw arguments after the command name.
 * Owns its own argument parsing, like the other early-routed read-only commands.
 */
export async function runMcpCommand(args: readonly string[]): Promise<number> {
  let configPath = 'jsails.app.js';
  let dbConfigPath: string | undefined;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (token === '--help' || token === '-h') {
      help = true;
    } else if (token === '--config') {
      const value = args[index + 1];
      if (value === undefined) {
        return reportUsageError(
          (line) => process.stderr.write(`${line}\n`),
          'Run "jsails mcp --help" for usage.',
          '--config requires a value',
        );
      }
      configPath = value;
      index += 1;
    } else if (token.startsWith('--config=')) {
      configPath = token.slice('--config='.length);
    } else if (token === '--db-config') {
      const value = args[index + 1];
      if (value === undefined) {
        return reportUsageError(
          (line) => process.stderr.write(`${line}\n`),
          'Run "jsails mcp --help" for usage.',
          '--db-config requires a value',
        );
      }
      dbConfigPath = value;
      index += 1;
    } else if (token.startsWith('--db-config=')) {
      dbConfigPath = token.slice('--db-config='.length);
    } else if (token.startsWith('-')) {
      return reportUsageError(
        (line) => process.stderr.write(`${line}\n`),
        'Run "jsails mcp --help" for usage.',
        `unknown option ${JSON.stringify(token)}`,
      );
    } else {
      return reportUsageError(
        (line) => process.stderr.write(`${line}\n`),
        'Run "jsails mcp --help" for usage.',
        `unexpected argument: ${token}`,
      );
    }
  }

  if (help) {
    process.stdout.write(mcpHelp());
    return 0;
  }

  // Set globals for config-path resolution in tool handlers.
  // The tools reference by env-relative config paths, so push them
  // into process.env so loadAppConfig resolves correctly.
  process.env.JSAILS_MCP_APP_CONFIG = configPath;
  if (dbConfigPath) {
    process.env.JSAILS_MCP_DB_CONFIG = dbConfigPath;
  }

  process.stderr.write(`jsails MCP server starting (config: ${configPath})\n`);

  try {
    const { buildJsailsMcpServer } = await import('../mcp/index.js');
    await buildJsailsMcpServer();
  } catch (error) {
    process.stderr.write(
      `jsails: ${formatError(error, { fallback: 'failed to start MCP server' })}\n`,
    );
    return 1;
  }

  return 0;
}
