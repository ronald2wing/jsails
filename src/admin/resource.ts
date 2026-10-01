/**
 * Admin resources: the public descriptor surface, re-exported from the split
 * modules.
 *
 * `defineResource(spec)` (see `resource/resource-descriptor.ts`) validates a
 * resource specification and returns a deeply frozen {@link Resource}
 * descriptor; the column types/validation live in `resource/columns.ts`, the
 * field types/validation in `resource/fields.ts`, the Zod coercion in
 * `resource/field-schemas.ts`, and the form/table markup rendering in
 * `resource/render.ts`. This barrel keeps the descriptor import path stable for
 * the panel, the blog admin resource, and the `jsails/admin` public surface.
 */

export {
  defineResource,
  type Resource,
  type ResourceAction,
  type ResourceAuthorize,
  type ResourceAuthorizeContext,
  type ResourceFileDiskContext,
  type ResourceFileDiskResolver,
  type ResourceGetContext,
  type ResourceListContext,
  type ResourceListResult,
  type ResourceSaveContext,
  type ResourceDefinition,
} from './resource/resource-descriptor.js';

export { ResourceError } from './resource/error.js';

export {
  DEFAULT_MAX_REPEATER_ITEMS,
  type ResourceField,
  type ResourceFieldType,
  type ResourceRepeaterConfig,
  type ResourceRepeaterItemField,
  type ResourceRepeaterItemType,
  type ResourceSelectOption,
} from './resource/fields.js';

export {
  type ResourceColumn,
  type ResourceColumnFormat,
  type ResourceInfolist,
  type ResourceInfolistEntry,
  type ResourceRelationResolver,
} from './resource/columns.js';

// Admin breadth: table grouping and bulk export.
// `groupRows` partitions list rows into ordered groups by a column value.
// `renderGroupedTable` emits group headers and per-group tables.
// `defineExportAction` creates a bulk-action descriptor that serializes
// selected rows to CSV or JSON; `serializeExport` returns the content +
// content-type for a download response.
export {
  groupRows,
  GroupRowsError,
  renderGroupedTable,
  type RowGroup,
  type GroupRowsOptions,
  type GroupLabelFn,
} from './resource/grouping.js';

export {
  defineExportAction,
  ExportActionError,
  serializeExport,
  resolveExportColumns,
  createExportRun,
  wireExportAction,
  type ExportAction,
  type ExportActionDefinition,
  type ExportActionWired,
  type ExportFormat,
  type ExportResult,
} from './resource/export.js';
