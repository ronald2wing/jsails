/**
 * Client model: a browser-safe, signal-backed projection of server state.
 *
 * This barrel re-exports the `createModel` primitive, the pull-only `bindModel`
 * helper, and their error/type surface. It is deliberately dependency-minimal —
 * the implementation imports only `@preact/signals`, so this module stays safe
 * for browser and Node alike.
 */

export {
  createModel,
  ModelError,
  type Model,
  type ModelDefinition,
  type ModelErrorCode,
  type ModelFieldOptions,
} from './model.js';

export { bindModel, type BoundModel, type ModelSource } from './bind-model.js';
