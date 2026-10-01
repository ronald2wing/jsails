/**
 * Server-components entry point: the server-only barrel for stateful server
 * components with backend actions.
 *
 * This subpath is NOT browser-safe: `extension.ts` and `runtime.ts` import
 * `node:crypto` and Preact, and `snapshot.ts` imports `node:crypto`. The root
 * `jsails` entry re-exports only the curated author surface (definitions plus
 * the render/extension seam); the advanced signer/runtime construction and the
 * wire protocol live here.
 *
 * Named re-exports only: this surface is deliberate, not a wildcard passthrough.
 */

export {
  defineAction,
  defineServerComponent,
  isRedirect,
  redirect,
  ServerComponentDefinitionError,
  type ServerComponentAction,
  type ServerComponentActionInput,
  type ServerComponentBindOptions,
  type ServerComponentCallAttrs,
  type ServerComponentDefinition,
  type ServerComponentModelAttrs,
  type ServerComponentPollAttrs,
  type ServerComponentPollOptions,
  type ServerComponentRedirect,
  type ServerComponentRenderTools,
  type ServerComponentState,
  type ServerComponentSubmitAttrs,
} from './component.js';

export {
  COMPONENT_SECRET_ENV,
  serverComponentsToken,
  ServerComponentError,
  UploadError,
  renderServerComponent,
  renderServerComponentHtml,
  resolveUpload,
  serverComponentsPlugin,
  uploadRefSchema,
  type ServerComponentsOptions,
  type ServerComponentsUploadOptions,
} from './extension.js';

// The declarative loader calls `mod.default(options)`, so every first-party
// subpath barrel must default-export its factory alongside the named export.
export { serverComponentsPlugin as default } from './extension.js';

export {
  createServerComponentsRuntime,
  ServerComponentRuntimeError,
  type ServerComponentsRuntimeOptions,
  type ResolveUploadOptions,
  type ResolvedUpload,
  type ServerComponentDownloadResult,
  type ServerComponentRenderOptions,
  type ServerComponentUpdateOptions,
  type ServerComponentUpdateResult,
  type ServerComponentUploadOptions,
  type ServerComponentUploadResult,
  type ServerComponentsRuntime,
} from './runtime.js';

export {
  createComponentSigner,
  SnapshotError,
  type ComponentSigner,
  type SnapshotPage,
  type SnapshotPayload,
  type SnapshotPayloadWithoutExpiry,
  type SnapshotSignerOptions,
  type SnapshotVerifyOptions,
} from './snapshot.js';

export {
  DownloadError,
  createDownloadReferenceSigner,
  download,
  isDownload,
  DOWNLOAD_REFERENCE_TTL_MS,
  type DownloadErrorCode,
  type DownloadOptions,
  type DownloadReader,
  type DownloadReferenceClaims,
  type DownloadReferenceSigner,
  type ServerComponentDownload,
} from './downloads.js';

export {
  ARGS_ATTRIBUTE,
  CALL_ATTRIBUTE,
  COMPONENT_ATTRIBUTE,
  COMPONENT_CSRF_ATTRIBUTE,
  COMPONENT_CSRF_HEADER,
  COMPONENT_DOWNLOAD_ENDPOINT,
  COMPONENT_NAME_ATTRIBUTE,
  COMPONENT_ROOT_ID_PREFIX,
  COMPONENT_SNAPSHOT_ATTRIBUTE,
  COMPONENT_UPDATE_ENDPOINT,
  COMPONENT_UPLOAD_ENDPOINT,
  COMPONENT_UPLOAD_FILE_FIELD,
  COMPONENT_UPLOAD_MAX_BYTES_ATTRIBUTE,
  COMPONENT_UPLOAD_SNAPSHOT_FIELD,
  COMPONENT_UPLOADING_ATTRIBUTE,
  CONFIRM_ATTRIBUTE,
  DEBOUNCE_ATTRIBUTE,
  DIRTY_ATTRIBUTE,
  ERROR_FOR_ATTRIBUTE,
  IGNORE_ATTRIBUTE,
  INTERSECT_ATTRIBUTE,
  LOADING_ATTRIBUTE,
  LOADING_TARGET_ATTRIBUTE,
  MAX_DEBOUNCE_MS,
  MAX_OPTION_LENGTH,
  MAX_OPTIONS,
  MAX_PATTERN_LENGTH,
  MAX_POLL_MARKER_LENGTH,
  MAX_RULES_JSON_LENGTH,
  MIN_POLL_INTERVAL_MS,
  MODEL_ATTRIBUTE,
  POLL_ATTRIBUTE,
  REFRESH_ACTION,
  REF_ATTRIBUTE,
  RULES_ATTRIBUTE,
  SHOW_ATTRIBUTE,
  SORT_ATTRIBUTE,
  SUBMIT_ATTRIBUTE,
  TEXT_ATTRIBUTE,
  TURBO_ATTRIBUTE,
  UPLOAD_REFERENCE_KEY,
  type ComponentPollOptions,
  type ComponentUpdateAction,
  type ComponentUpdateDownload,
  type ComponentUpdateError,
  type ComponentUpdateErrorCode,
  type ComponentUpdateRequest,
  type ComponentUpdateResponse,
  type ComponentUploadError,
  type ComponentUploadErrorCode,
  type ComponentUploadResponse,
  type FieldRuleTypeHint,
  type FieldValidationRules,
  type UploadReference,
} from './protocol.js';

export {
  confirmAttrs,
  ignoreAttrs,
  intersectAttrs,
  loadingTargetAttrs,
  refAttrs,
  showAttrs,
  sortAttrs,
  textAttrs,
} from './directives.js';

export { extractFieldRules, serializeFieldRules, ValidationMetaError } from './validation-meta.js';

export {
  defineForm,
  FormDefinitionError,
  type DefineFormOptions,
  type FormObject,
  type FormValidationResult,
} from './form.js';

export { pagerAttrs, type ServerComponentPagerOptions } from './pagination.js';

export { seedFromUrl, type ServerComponentUrlBinding } from './url-binding.js';

export {
  defineNestedComponent,
  renderNested,
  MAX_NESTING_DEPTH,
  NestedComponentError,
  type NestedComponentConfig,
} from './nested.js';

export { defineSimpleComponent, type DefineSimpleComponentOptions } from './simple.js';
