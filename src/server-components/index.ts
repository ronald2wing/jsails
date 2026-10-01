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
  ServerComponentDefinitionError,
  type ServerComponentAction,
  type ServerComponentActionInput,
  type ServerComponentCallAttrs,
  type ServerComponentDefinition,
  type ServerComponentModelAttrs,
  type ServerComponentRenderTools,
  type ServerComponentState,
  type ServerComponentSubmitAttrs,
} from './component.js';

export {
  COMPONENT_SECRET_ENV,
  SERVER_COMPONENTS,
  ServerComponentsError,
  renderServerComponent,
  renderServerComponentHtml,
  serverComponents,
  type ServerComponentsOptions,
} from './extension.js';

export {
  createServerComponentsRuntime,
  ServerComponentRuntimeError,
  type CreateServerComponentsRuntimeOptions,
  type ServerComponentRenderOptions,
  type ServerComponentUpdateOptions,
  type ServerComponentUpdateResult,
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
  ARGS_ATTRIBUTE,
  CALL_ATTRIBUTE,
  COMPONENT_ATTRIBUTE,
  COMPONENT_CSRF_ATTRIBUTE,
  COMPONENT_CSRF_HEADER,
  COMPONENT_NAME_ATTRIBUTE,
  COMPONENT_ROOT_ID_PREFIX,
  COMPONENT_SNAPSHOT_ATTRIBUTE,
  COMPONENT_UPDATE_ENDPOINT,
  MODEL_ATTRIBUTE,
  SUBMIT_ATTRIBUTE,
  TURBO_ATTRIBUTE,
  type ComponentUpdateAction,
  type ComponentUpdateError,
  type ComponentUpdateErrorCode,
  type ComponentUpdateRequest,
  type ComponentUpdateResponse,
} from './protocol.js';
