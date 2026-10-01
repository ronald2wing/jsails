/**
 * Minimal OpenAPI 3 document generation from a map of declared resources.
 *
 * `generateOpenApi` takes a name-keyed map of resources — each declaring its
 * collection path, an optional tag, query parameters, and request/response JSON
 * schemas — and produces a deterministic OpenAPI 3.0 document with the five
 * resource operations per resource:
 *
 * - `GET {path}` (list), `POST {path}` (create),
 * - `GET {path}/{id}` (get), `PATCH {path}/{id}` (update),
 *   `DELETE {path}/{id}` (delete).
 *
 * Output is deterministic: resources are sorted by path (then name), paths are
 * emitted in sorted order, query parameters are sorted by name, tags are sorted,
 * and every operation builds its fields in a fixed order. No external OpenAPI
 * library is used — the document is a plain JSON-compatible object, so it
 * serializes with `JSON.stringify` with no dependency.
 */

/** A minimal JSON Schema subset sufficient to describe request/response shapes. */
export interface OpenApiJsonSchema {
  readonly type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';
  readonly description?: string;
  readonly properties?: Readonly<Record<string, OpenApiJsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: OpenApiJsonSchema;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly format?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly default?: unknown;
}

/** A query parameter declaration for the list operation. */
export interface OpenApiQueryParam {
  readonly name: string;
  readonly required?: boolean;
  readonly schema: OpenApiJsonSchema;
  readonly description?: string;
}

/** A declared resource. */
export interface OpenApiResource {
  /** Collection path, e.g. `/users`. */
  readonly path: string;
  /** Tag grouping this resource's operations. Defaults to the resource name. */
  readonly tag?: string;
  /** Short description used for operation summaries. */
  readonly description?: string;
  /** Detail-route parameter name. Defaults to `"id"`. */
  readonly idParam?: string;
  /** Query parameters for the list operation. */
  readonly queryParams?: readonly OpenApiQueryParam[];
  /** Request body schema for create/update. */
  readonly requestSchema?: OpenApiJsonSchema;
  /** Response item schema. */
  readonly responseSchema?: OpenApiJsonSchema;
}

/** A path or query parameter. */
export interface OpenApiParameter {
  readonly name: string;
  readonly in: 'query' | 'path';
  readonly required?: boolean;
  readonly schema: OpenApiJsonSchema;
  readonly description?: string;
}

/** A response entry. */
export interface OpenApiResponse {
  readonly description: string;
  readonly content?: {
    readonly 'application/json': { readonly schema: OpenApiJsonSchema };
  };
}

/** An operation (get/post/patch/delete) under a path. */
export interface OpenApiOperation {
  readonly tags?: readonly string[];
  readonly summary?: string;
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: {
    readonly required: true;
    readonly content: { readonly 'application/json': { readonly schema: OpenApiJsonSchema } };
  };
  readonly responses: Readonly<Record<string, OpenApiResponse>>;
}

/** The generated document. */
export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>;
  readonly tags?: readonly { readonly name: string }[];
}

/** Options for {@link generateOpenApi}. */
export interface GenerateOpenApiOptions {
  /** Document title. Defaults to `"API"`. */
  readonly title?: string;
  /** Document version. Defaults to `"0.1.0"`. */
  readonly version?: string;
  /** Resources keyed by name. */
  readonly resources: Readonly<Record<string, OpenApiResource>>;
}

/** Generate a minimal, deterministic OpenAPI 3 document. */
export function generateOpenApi(options: GenerateOpenApiOptions): OpenApiDocument {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('generateOpenApi requires an options object');
  }
  if (
    options.resources === null ||
    typeof options.resources !== 'object' ||
    Array.isArray(options.resources)
  ) {
    throw new TypeError('resources must be an object keyed by resource name');
  }

  const paths = new Map<string, Record<string, OpenApiOperation>>();
  const tags = new Set<string>();

  const resources = Object.entries(options.resources)
    .map(([name, resource]) => ({ name, resource }))
    .sort((a, b) => byPath(a.resource, b.resource) || a.name.localeCompare(b.name));

  for (const { name, resource } of resources) {
    const tag = resource.tag ?? name;
    tags.add(tag);
    assertResource(resource);

    const idParam = resource.idParam ?? 'id';
    const collectionPath = resource.path;
    const detailPath = `${stripTrailingSlash(collectionPath)}/{${idParam}}`;
    const pathParameter: OpenApiParameter = {
      name: idParam,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    };
    const queryParams = [...(resource.queryParams ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((param): OpenApiParameter => ({
        name: param.name,
        in: 'query',
        required: param.required === true,
        schema: param.schema,
        ...(param.description !== undefined ? { description: param.description } : {}),
      }));

    const listOperation: OpenApiOperation = {
      tags: [tag],
      ...(resource.description !== undefined
        ? { summary: `List ${resource.description}` }
        : { summary: `List ${name}` }),
      ...(queryParams.length > 0 ? { parameters: queryParams } : {}),
      responses: {
        '200': jsonResponse('A list of resources', arraySchema(resource.responseSchema)),
      },
    };

    const createOperation: OpenApiOperation = {
      tags: [tag],
      ...(resource.description !== undefined
        ? { summary: `Create ${resource.description}` }
        : { summary: `Create ${name}` }),
      ...(resource.requestSchema !== undefined
        ? { requestBody: jsonRequestBody(resource.requestSchema) }
        : {}),
      responses: { '201': jsonResponse('Created', resource.responseSchema) },
    };

    const detailOperations: Record<string, OpenApiOperation> = {
      get: {
        tags: [tag],
        ...(resource.description !== undefined
          ? { summary: `Retrieve ${resource.description}` }
          : { summary: `Retrieve ${name}` }),
        parameters: [pathParameter],
        responses: { '200': jsonResponse('The resource', resource.responseSchema) },
      },
      patch: {
        tags: [tag],
        ...(resource.description !== undefined
          ? { summary: `Update ${resource.description}` }
          : { summary: `Update ${name}` }),
        parameters: [pathParameter],
        ...(resource.requestSchema !== undefined
          ? { requestBody: jsonRequestBody(resource.requestSchema) }
          : {}),
        responses: { '200': jsonResponse('The resource', resource.responseSchema) },
      },
      delete: {
        tags: [tag],
        ...(resource.description !== undefined
          ? { summary: `Delete ${resource.description}` }
          : { summary: `Delete ${name}` }),
        parameters: [pathParameter],
        responses: { '204': { description: 'No content' } },
      },
    };

    setOperation(paths, collectionPath, 'get', listOperation);
    setOperation(paths, collectionPath, 'post', createOperation);
    for (const [method, operation] of Object.entries(detailOperations)) {
      setOperation(paths, detailPath, method, operation);
    }
  }

  const sortedPaths: Record<string, Record<string, OpenApiOperation>> = {};
  for (const path of [...paths.keys()].sort()) {
    const operations = paths.get(path);
    if (operations !== undefined) {
      sortedPaths[path] = operations;
    }
  }

  const document: OpenApiDocument = {
    openapi: '3.0.3',
    info: { title: options.title ?? 'API', version: options.version ?? '0.1.0' },
    paths: sortedPaths,
    tags: [...tags].sort().map((name) => ({ name })),
  };
  return document;
}

function byPath(a: OpenApiResource, b: OpenApiResource): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function assertResource(resource: OpenApiResource): void {
  if (typeof resource.path !== 'string' || !resource.path.startsWith('/')) {
    throw new TypeError('resource path must be a string starting with "/"');
  }
  if (
    resource.idParam !== undefined &&
    (typeof resource.idParam !== 'string' || resource.idParam.length === 0)
  ) {
    throw new TypeError('idParam must be a non-empty string');
  }
}

function jsonRequestBody(schema: OpenApiJsonSchema): {
  readonly required: true;
  readonly content: { readonly 'application/json': { readonly schema: OpenApiJsonSchema } };
} {
  return { required: true, content: { 'application/json': { schema } } };
}

/** Build a list response schema; `items` is omitted when no item schema is given. */
function arraySchema(item: OpenApiJsonSchema | undefined): OpenApiJsonSchema {
  return item === undefined ? { type: 'array' } : { type: 'array', items: item };
}

function jsonResponse(description: string, schema?: OpenApiJsonSchema): OpenApiResponse {
  if (schema === undefined) {
    return { description };
  }
  return { description, content: { 'application/json': { schema } } };
}

function setOperation(
  paths: Map<string, Record<string, OpenApiOperation>>,
  path: string,
  method: string,
  operation: OpenApiOperation,
): void {
  const operations = paths.get(path) ?? {};
  operations[method] = operation;
  paths.set(path, operations);
}
