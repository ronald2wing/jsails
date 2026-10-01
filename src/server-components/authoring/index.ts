/**
 * Authoring-layer entry point: the friendly `defineComponent` API and its
 * support modules (`actions`, `style`).
 *
 * Named re-exports only — no wildcard passthrough — matching the barrel style
 * of `src/server-components/index.ts`.
 */

export {
  localAction,
  serverAction,
  lowerActions,
  AuthoringError,
  type ActionKind,
  type AuthoringErrorCode,
  type LocalAction,
  type ServerAction,
} from './actions.js';

export { defineStyle, StyleError, type StyleContract, type StyleErrorCode } from './style.js';

export {
  defineComponent,
  type AuthoringRenderTools,
  type DefineComponentOptions,
} from './define-component.js';
