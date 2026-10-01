/**
 * Browser component bindings: the public entry for the DOM binding layer.
 *
 * This is the assembly barrel for the stateful server-component bindings. The
 * DOM half (root bootstrapping, delegated input/click/submit handling, morphing,
 * and poll scheduling) lives in `controller.ts`, backed by three per-concern
 * siblings — `control-values.ts` (control read/write and capture/reapply),
 * `rules.ts` (rule parsing/evaluation), and `uploads.ts` (file-upload glue).
 * Only the public surface below is re-exported; the siblings' internal helpers
 * are consumed by `controller.ts` and stay private.
 */

export {
  COMPONENT_BLOCKED_MESSAGE,
  COMPONENT_UPLOAD_FAILED_MESSAGE,
  ComponentBindingError,
  createComponentBindings,
  evaluateFieldRules,
  parseActionArgs,
  parseFieldRules,
  readControlValue,
  type ComponentBindings,
  type ComponentDocument,
  type ComponentElement,
  type PollSignals,
} from './controller.js';
