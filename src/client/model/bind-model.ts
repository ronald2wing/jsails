/**
 * Pull-only binding of a model projection to a live state source.
 *
 * `createModel` projects a snapshot into signals; `bindModel` couples that
 * projection to the object that *owns* the authoritative state (a live
 * component controller), so the projection can be re-read on demand. The
 * helper is deliberately **pull-only**: it never subscribes to the source,
 * never pushes a `model.set` edit back into the source, and never calls
 * `model.set` on its own. The binding layer owns the push side — it calls
 * `project()` whenever the controller's state changes (for example inside the
 * controller's `onRender`/`applyRender` path). That keeps the source the single
 * authority over state: the model is only ever a downstream projection, so a
 * local edit can never silently corrupt server-owned state.
 *
 * Like `createModel`, this module imports only `@preact/signals` and the model
 * primitive, so it stays safe to import and test under plain Node.
 */
import { isPlainObject } from '../../internal/json-safe.js';
import { createModel, ModelError, type Model, type ModelDefinition } from './model.js';

/**
 * Duck-typed minimal contract for the object owning the authoritative state.
 *
 * The real `ComponentController` satisfies this structurally (its `state` is a
 * `JsonObject`, which extends `Record<string, unknown>`); the controller type is
 * deliberately not imported so this module stays dependency-free.
 */
export interface ModelSource {
  readonly state: Record<string, unknown>;
}

/** A model bound to a source; `project()` re-reads the source on demand. */
export interface BoundModel {
  readonly model: Model;
  project(): void;
  dispose(): void;
}

/**
 * Bind a model to a state source and project the source's current state once.
 *
 * The `source` contract is validated here (value-free); `definition` is
 * validated by `createModel` itself. The returned descriptor is frozen to match
 * `createModel`'s return style.
 */
export function bindModel(source: ModelSource, definition: ModelDefinition): BoundModel {
  if (!isPlainObject(source) || !isPlainObject(source.state)) {
    throw new ModelError('model source must expose a state object', 'invalid_definition');
  }

  const model = createModel(definition);
  model.project(source.state);

  return Object.freeze({
    model,

    project(): void {
      // Re-read the source each call so the caller can drive re-projection after
      // any number of source mutations without the helper tracking them.
      model.project(source.state);
    },

    dispose(): void {
      model.dispose();
    },
  });
}
