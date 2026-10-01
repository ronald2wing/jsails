/**
 * Browser-agnostic API barrel: schema validation, serializers, pagination,
 * resource handlers, list-query filters, permission composition, rate limiting,
 * form parsing, and OpenAPI generation. These modules depend only on Zod and
 * web-standard types (`Request`/`Response`/`URL`), so this entry is safe to load
 * in a browser bundle as well as on the server. It never opens a database,
 * Valkey, or HTTP connection at import time.
 *
 * Named re-exports only: this surface is deliberate, not a wildcard passthrough.
 */

export {
  array,
  boolean,
  integer,
  object,
  optional,
  string,
  ValidationError,
  type ArrayOptions,
  type BooleanOptions,
  type FieldOptions,
  type FieldPath,
  type Infer,
  type IntegerOptions,
  type ObjectOptions,
  type Schema,
  type StringOptions,
  type ValidationIssue,
} from './validation.js';

export {
  defineSerializer,
  type ReadOutput,
  type Serializer,
  type SerializerField,
  type SerializerFields,
  type ValidateOptions,
  type WriteInput,
} from './serialization.js';

export {
  DEFAULT_MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  normalizePagination,
  paginate,
  paginateArray,
  type NormalizedPagination,
  type Page,
  type PaginationOptions,
  type QueryAdapter,
} from './pagination.js';

export {
  createResourceHandlers,
  type Authorize,
  type CollectionHandlers,
  type ResourceHandlersOptions,
  type DetailHandlers,
  type ResourceAction,
  type ResourceHandler,
  type ResourceHandlers,
  type ResourceStore,
} from './resource.js';

export {
  matchesSearch,
  parseFilters,
  type FilterClause,
  type FilterFieldOptions,
  type FilterOperator,
  type FilterOptions,
  type FilterValue,
  type NormalizedQuery,
  type SortClause,
} from './filters.js';

export {
  and,
  or,
  require,
  resourcePolicy,
  createPermissionRegistry,
  type PermissionPredicate,
  type PermissionRegistry,
  type ResourcePolicy,
} from './permissions.js';

export { throttle, type ThrottleDecision, type ThrottleOptions } from './throttling.js';

export { readForm, type FormResult, type ReadFormOptions } from './forms.js';

export {
  generateOpenApi,
  type GenerateOpenApiOptions,
  type OpenApiDocument,
  type OpenApiJsonSchema,
  type OpenApiOperation,
  type OpenApiParameter,
  type OpenApiQueryParam,
  type OpenApiResource,
  type OpenApiResponse,
} from './openapi.js';

export { createResourceRouter, type RouteEntry, type RouterOptions } from './router.js';

export {
  DeclarativeResourceError,
  defineDeclarativeResource,
  type DeclarativeResource,
  type DeclarativeResourceOptions,
} from './declarative-resource.js';

export {
  resolveApiVersion,
  versionedNotFound,
  versionedNotAcceptable,
  type VersionFailure,
  type VersioningOptions,
  type VersionOk,
  type VersionResult,
} from './versioning.js';
