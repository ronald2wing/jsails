/**
 * Browser-agnostic API barrel: schema validation, serializers, pagination, and
 * resource handlers. These modules depend only on Zod and web-standard types
 * (`Request`/`Response`/`URL`), so this entry is safe to load in a browser
 * bundle as well as on the server. It never opens a database, Valkey, or HTTP
 * connection at import time.
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
  type CreateResourceHandlersOptions,
  type DetailHandlers,
  type ResourceAction,
  type ResourceHandler,
  type ResourceHandlers,
  type ResourceStore,
} from './resource.js';
