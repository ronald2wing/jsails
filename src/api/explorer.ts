/**
 * API Explorer renderer (`renderApiExplorer`).
 *
 * Produces a self-contained HTML page listing the paths and methods from an
 * OpenAPI 3 document, grouped by resource tag. The output is a string with
 * inline CSS — no external CDN, no JS bundle, no `node:*` imports — so the
 * render function is safe to call server-side and browser-side.
 *
 * Every user-supplied field (titles, summaries, parameter names, descriptions,
 * tag names, path strings) is HTML-escaped. The page is read-only: no form
 * submission, no request-maker. This is the honest, zero-dependency listing;
 * a full interactive Swagger UI is out of scope.
 */

import type { OpenApiDocument } from './openapi.js';

/**
 * Render a browsable API explorer page from an OpenAPI document.
 *
 * @returns a self-contained HTML string with embedded CSS.
 */
export function renderApiExplorer(openApi: OpenApiDocument): string {
  const title = esc(openApi.info.title);
  const version = esc(openApi.info.version);

  // Group all operations by their first tag. Operations without tags are
  // collected under an "Other" group.
  const groups = new Map<string, Array<{ path: string; method: string; operation: unknown }>>();
  const tagOrder: string[] = [];
  for (const [path, methods] of Object.entries(openApi.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const tags = (operation as { tags?: string[] }).tags;
      const tag = tags !== undefined && tags.length > 0 ? (tags[0] as string) : 'Other';
      if (!groups.has(tag)) {
        groups.set(tag, []);
        tagOrder.push(tag);
      }
      const list = groups.get(tag)!;
      list.push({ path, method, operation });
    }
  }

  // Sort tagOrder alphabetically, with "Other" last.
  tagOrder.sort((a, b) => {
    if (a === 'Other') return 1;
    if (b === 'Other') return -1;
    return a.localeCompare(b);
  });

  // Sort operations within each tag by path then method.
  for (const [, ops] of groups) {
    ops.sort((a, b) => {
      const pathCmp = a.path.localeCompare(b.path);
      if (pathCmp !== 0) return pathCmp;
      const methodOrder = methodRank(a.method) - methodRank(b.method);
      if (methodOrder !== 0) return methodOrder;
      return a.method.localeCompare(b.method);
    });
  }

  // Build sections.
  let sections = '';
  for (const tag of tagOrder) {
    const ops = groups.get(tag)!;
    sections += renderTagSection(esc(tag), ops);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — API Explorer</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    line-height: 1.5;
    color: #1a1a2e;
    background: #f8f9fa;
    padding: 2rem 1.5rem;
    max-width: 960px;
    margin: 0 auto;
  }
  h1 { font-size: 1.6rem; font-weight: 600; margin-bottom: .15rem; }
  .version { font-size: .85rem; color: #6b7280; margin-bottom: 1.5rem; }
  .tag-section { margin-bottom: 2rem; }
  .tag-heading {
    font-size: 1.15rem; font-weight: 600; padding: .4rem .6rem;
    background: #e5e7eb; border-radius: 6px; margin-bottom: .75rem;
  }
  .endpoint {
    border: 1px solid #d1d5db; border-radius: 8px; margin-bottom: .75rem;
    background: #fff; overflow: hidden;
  }
  .endpoint-header {
    display: flex; align-items: center; gap: .75rem; padding: .6rem .75rem;
    background: #f3f4f6; border-bottom: 1px solid #d1d5db;
  }
  .method {
    font-size: .8rem; font-weight: 700; text-transform: uppercase;
    padding: .15rem .45rem; border-radius: 4px; min-width: 3.8rem;
    text-align: center; letter-spacing: .04em;
  }
  .method.get    { background: #d1fae5; color: #065f46; }
  .method.post   { background: #dbeafe; color: #1e40af; }
  .method.patch  { background: #fef3c7; color: #92400e; }
  .method.delete { background: #fee2e2; color: #991b1b; }
  .method.put    { background: #ede9fe; color: #5b21b6; }
  .path { font-family: "SF Mono", "Fira Code", monospace; font-size: .9rem; }
  .summary { font-size: .9rem; color: #374151; margin-left: auto; }
  .endpoint-body { padding: .6rem .75rem; }
  .endpoint-body p { font-size: .85rem; color: #4b5563; }
  .params { margin-top: .4rem; }
  .params-heading { font-size: .8rem; font-weight: 600; color: #6b7280; margin-bottom: .25rem; }
  .param {
    display: flex; gap: .5rem; font-size: .82rem; padding: .15rem 0;
    border-bottom: 1px solid #f3f4f6;
  }
  .param:last-child { border-bottom: 0; }
  .param-name {
    font-family: "SF Mono", "Fira Code", monospace; font-weight: 600;
    min-width: 8rem; color: #1f2937;
  }
  .param-type { color: #6b7280; font-size: .78rem; }
  .param-desc { color: #4b5563; }
  .param-required { color: #dc2626; font-size: .75rem; font-weight: 600; }
  .empty { text-align: center; color: #6b7280; padding: 2rem; }
  footer {
    margin-top: 2rem; text-align: center; font-size: .8rem; color: #9ca3af;
  }
</style>
</head>
<body>
<h1>${title}</h1>
<p class="version">API version ${version}</p>
${sections || '<p class="empty">No API operations found.</p>'}
<footer>Generated by JSails API Explorer</footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render an HTML section for one tag/resource group. */
function renderTagSection(
  tag: string,
  operations: Array<{ path: string; method: string; operation: unknown }>,
): string {
  let html = `<div class="tag-section"><h2 class="tag-heading">${tag}</h2>`;
  for (const { path, method, operation } of operations) {
    html += renderEndpoint(esc(path), method, operation);
  }
  html += '</div>';
  return html;
}

/** Render one endpoint (path + method + operation details). */
function renderEndpoint(path: string, method: string, operation: unknown): string {
  const op = operation as {
    summary?: string;
    parameters?: Array<{
      name: string;
      in: string;
      required?: boolean;
      schema?: { type?: string };
      description?: string;
    }>;
    requestBody?: {
      required: true;
      content: { 'application/json': { schema: { type?: string } } };
    };
  };

  const methodClass = method.toLowerCase();
  const summary = op.summary !== undefined ? esc(op.summary) : '';
  const params = renderParameters(op.parameters);
  const bodyNote = op.requestBody !== undefined ? `<p>Request body: application/json</p>` : '';

  return `
<div class="endpoint">
  <div class="endpoint-header">
    <span class="method ${methodClass}">${method.toUpperCase()}</span>
    <span class="path">${path}</span>
    <span class="summary">${summary}</span>
  </div>
  <div class="endpoint-body">
    ${bodyNote}${params}
  </div>
</div>`;
}

/** Render a parameter list section. Returns empty string when there are none. */
function renderParameters(
  parameters:
    | Array<{
        name: string;
        in: string;
        required?: boolean;
        schema?: { type?: string };
        description?: string;
      }>
    | undefined,
): string {
  if (parameters === undefined || parameters.length === 0) return '';
  let html = '<div class="params"><div class="params-heading">Parameters</div>';
  for (const param of parameters) {
    const type = param.schema?.type ?? 'string';
    const desc = param.description !== undefined ? esc(param.description) : '';
    const required =
      param.required === true ? ' <span class="param-required">*required</span>' : '';
    html += `
<div class="param">
  <span class="param-name">${esc(param.name)}</span>
  <span class="param-type">(${esc(param.in)}: ${esc(type)})</span>
  ${desc ? `<span class="param-desc">${desc}</span>` : ''}${required}
</div>`;
  }
  html += '</div>';
  return html;
}

/** HTML-escape a string: replace &, <, >, ", ' with entities, and strip NUL. */
function esc(value: string): string {
  return value
    .replace(/\x00/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Rank HTTP methods for display order. */
function methodRank(method: string): number {
  const order: Record<string, number> = {
    get: 0,
    post: 1,
    put: 2,
    patch: 3,
    delete: 4,
  };
  return order[method.toLowerCase()] ?? 99;
}
