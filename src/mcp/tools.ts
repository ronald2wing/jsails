/**
 * Built-in JSails MCP tools.
 *
 * Each tool wraps an existing read-only introspection function — never
 * reimplements discovery or schema extraction.  Results are serialized as
 * JSON text content.
 *
 * Server-only: imports the app config loader, route discovery, schema
 * extraction, explain matching, and plugin enablement.
 */

import { defineMcpTool, type McpTool } from './tool.js';
import { buildDescribeResult } from '../cli/describe-commands.js';
import { runExplain, type ExplainDeps } from '../cli/explain-commands.js';
import { discoverRoutes } from '../routing/routes.js';
import { loadAppConfig } from '../app/config/index.js';

// ---------------------------------------------------------------------------
// Shared config-path resolution
// ---------------------------------------------------------------------------

function resolveConfigPath(args: Record<string, unknown>): string {
  return typeof args.configPath === 'string' && args.configPath.length > 0
    ? args.configPath
    : 'jsails.app.js';
}

function resolveDbConfigPath(args: Record<string, unknown>): string | undefined {
  return typeof args.dbConfigPath === 'string' && args.dbConfigPath.length > 0
    ? args.dbConfigPath
    : undefined;
}

// ---------------------------------------------------------------------------
// jsails_describe
// ---------------------------------------------------------------------------

const jsailsDescribeTool = defineMcpTool({
  name: 'jsails_describe',
  description:
    'Compose a machine-readable snapshot of the JSails app definition: routes, plugins, commands, server components, and the declared entity schema.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      configPath: {
        type: 'string',
        description: 'Path to the compiled app config module (default: jsails.app.js)',
      },
      dbConfigPath: {
        type: 'string',
        description: 'Path to the database config module (default: jsails.config.js)',
      },
    },
  },

  async handler(args: Record<string, unknown>) {
    const result = await buildDescribeResult({
      configPath: resolveConfigPath(args),
      dbConfigPath: resolveDbConfigPath(args),
      options: { json: true },
    });
    return result;
  },
});

// ---------------------------------------------------------------------------
// jsails_inspect_routes
// ---------------------------------------------------------------------------

const jsailsInspectRoutesTool = defineMcpTool({
  name: 'jsails_inspect_routes',
  description:
    'List every filesystem route (page / API) discovered from the compiled pages/ and api/ directories.',

  inputSchema: {
    type: 'object' as const,
    properties: {
      configPath: {
        type: 'string',
        description: 'Path to the compiled app config module (default: jsails.app.js)',
      },
    },
  },

  async handler(args: Record<string, unknown>) {
    const config = await loadAppConfig(resolveConfigPath(args));

    const manifest = discoverRoutes(config.rootDir, {
      pagesDir: config.pagesDir,
      apiDir: config.apiDir,
    });

    return manifest.entries.map((entry) => ({
      kind: entry.kind,
      route: entry.route,
      dynamic: entry.dynamic,
      catchAll: entry.catchAll,
      params: entry.params,
      layoutCount: entry.layouts?.length ?? 0,
    }));
  },
});

// ---------------------------------------------------------------------------
// jsails_explain_route
// ---------------------------------------------------------------------------

const jsailsExplainRouteTool = defineMcpTool({
  name: 'jsails_explain_route',
  description:
    'Resolve which route handles a request path and show the matched route, any extracted parameter values, and the fixed pipeline stages for that request.',

  inputSchema: {
    type: 'object' as const,
    properties: {
      configPath: {
        type: 'string',
        description: 'Path to the compiled app config module (default: jsails.app.js)',
      },
      path: {
        type: 'string',
        description: 'The request path to resolve (e.g. /blog/hello)',
      },
    },
    required: ['path'] as const,
  },

  async handler(args: Record<string, unknown>) {
    const path = args.path;
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('path parameter is required');
    }

    const config = await loadAppConfig(resolveConfigPath(args));

    // Capture explain output by providing an in-memory stdout.
    let captured = '';
    const explainDeps: ExplainDeps = {
      loadConfig: () => Promise.resolve(config),
      stdout: (text: string) => {
        captured += `${text}\n`;
      },
      stderr: () => {},
    };

    await runExplain({ configPath: resolveConfigPath(args), path, json: true }, explainDeps);

    // With json: true, captured is one JSON line.
    return JSON.parse(captured.trim());
  },
});

// ---------------------------------------------------------------------------
// jsails_schema
// ---------------------------------------------------------------------------

const jsailsSchemaTool = defineMcpTool({
  name: 'jsails_schema',
  description:
    'Extract the declared entity schema (tables, columns, indexes, foreign keys) from application model metadata without connecting to a database. Returns an empty tables array when no database config exists.',

  inputSchema: {
    type: 'object' as const,
    properties: {
      dbConfigPath: {
        type: 'string',
        description: 'Path to the database config module (default: jsails.config.js)',
      },
    },
  },

  async handler(args: Record<string, unknown>) {
    // loadSchemaFromConfig is a private helper — use buildDescribeResult
    // with the schema section isolated.
    const dbConfigPath = resolveDbConfigPath(args) ?? 'jsails.config.js';
    const result = await buildDescribeResult({
      configPath: resolveConfigPath(args),
      dbConfigPath,
      options: { json: true },
    });
    return result.schema;
  },
});

// ---------------------------------------------------------------------------
// Tool set
// ---------------------------------------------------------------------------

/** The built-in JSails MCP tools. */
export const jsailsMcpTools: readonly McpTool[] = Object.freeze([
  jsailsDescribeTool,
  jsailsInspectRoutesTool,
  jsailsExplainRouteTool,
  jsailsSchemaTool,
]);

export { jsailsDescribeTool, jsailsInspectRoutesTool, jsailsExplainRouteTool, jsailsSchemaTool };
