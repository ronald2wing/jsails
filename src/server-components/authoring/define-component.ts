/**
 * `defineComponent` — the friendly authoring sugar that lowers onto
 * `defineServerComponent`.
 *
 * This is the primary author-facing API for the HotView/Livewire-influenced
 * component model. It accepts a flat options object with `actions` split by
 * capability (`local` vs `server`), `derived` computed properties (aliased to
 * `computed`), and a `style` contract — then lowers them all to the runtime's
 * `ServerComponentDefinition` shape exactly once.
 *
 * All validation is delegated to `defineServerComponent`; this module adds no
 * new validation beyond the lower steps (which reject malformed authoring-layer
 * shapes before they reach the runtime).
 */

import { z } from 'zod';

import type { RenderChild } from '../../contracts/component.js';
import type { RequestContext } from '../../contracts/http.js';
import type {
  ServerComponentComputed,
  ServerComponentDefinition,
  ServerComponentRenderTools,
  ServerComponentState,
} from '../component.js';
import { defineServerComponent } from '../component.js';
import { lowerActions, type LocalAction, type ServerAction } from './actions.js';
import type { StyleContract } from './style.js';

// ---------------------------------------------------------------------------
// Authoring render tools
// ---------------------------------------------------------------------------

/**
 * Render tools threaded into a `defineComponent` render function.
 *
 * Extends the runtime's `ServerComponentRenderTools` with `derived(name)`, a
 * convenience alias for `tools.computed(name)` so the author surface uses the
 * same `derived` term as the options block.
 */
export type AuthoringRenderTools<State extends ServerComponentState> =
  ServerComponentRenderTools<State> & {
    readonly derived: (name: string) => unknown;
  };

// ---------------------------------------------------------------------------
// DefineComponent options
// ---------------------------------------------------------------------------

/** Options accepted by {@link defineComponent}. */
export interface DefineComponentOptions<State extends ServerComponentState> {
  readonly name: string;
  readonly stateSchema: z.ZodType<State>;
  readonly writableKeys?: readonly (keyof State & string)[];
  readonly actions?: Readonly<
    Record<string, LocalAction<NoInfer<State>, any> | ServerAction<NoInfer<State>, any>>
  >;
  readonly derived?: Readonly<Record<string, ServerComponentComputed<NoInfer<State>>>>;
  readonly style?: StyleContract;
  readonly urlBinding?: readonly string[];
  initialState(context: RequestContext): State | Promise<State>;
  authorize(context: RequestContext): boolean | Promise<boolean>;
  hydrate?(state: State, context: RequestContext): void | Promise<void>;
  updating?(state: State, context: RequestContext): void | Promise<void>;
  updated?(state: State, context: RequestContext): void | Promise<void>;
  mount?(context: RequestContext): void | Promise<void>;
  render(state: State, tools: AuthoringRenderTools<State>): RenderChild | Promise<RenderChild>;
  staticFallback?(context: RequestContext): RenderChild | Promise<RenderChild>;
}

// ---------------------------------------------------------------------------
// defineComponent
// ---------------------------------------------------------------------------

/**
 * Define a server component from the friendly authoring surface, lowering
 * `actions` (split by capability), `derived` (→ `computed`), and `style`
 * onto `defineServerComponent`.
 *
 * The returned definition carries the extra `style` property as an own-key
 * outside of the `ServerComponentDefinition` interface; it survives the
 * `{ ...definition }` spread in `defineServerComponent` and is intended for
 * the Phase 4 client wiring — the runtime does not consume it.
 */
export function defineComponent<State extends ServerComponentState>(
  options: DefineComponentOptions<State>,
): ServerComponentDefinition<State> {
  const loweredActions = options.actions !== undefined ? lowerActions(options.actions) : undefined;

  // `derived` maps to the runtime's `computed`: same function shape, different
  // author-facing name so the convention matches the options block.
  const loweredComputed = options.derived;

  // Wrap `render`: spread the existing tools and add `derived` as an alias for
  // `computed`. The runtime's `computed(name)` is still available, but the
  // author surface uses `tools.derived(name)` for consistency.
  const loweredRender =
    options.render !== undefined
      ? (state: State, tools: ServerComponentRenderTools<State>) =>
          options.render(state, { ...tools, derived: (name) => tools.computed(name) })
      : undefined;

  const lowered: Record<string, unknown> = {
    name: options.name,
    stateSchema: options.stateSchema,
    initialState: options.initialState,
    authorize: options.authorize,
    render: loweredRender,
    ...(options.writableKeys !== undefined ? { writableKeys: options.writableKeys } : {}),
    ...(loweredActions !== undefined ? { actions: loweredActions } : {}),
    ...(loweredComputed !== undefined ? { computed: loweredComputed } : {}),
    ...(options.urlBinding !== undefined ? { urlBinding: options.urlBinding } : {}),
    ...(options.hydrate !== undefined ? { hydrate: options.hydrate } : {}),
    ...(options.updating !== undefined ? { updating: options.updating } : {}),
    ...(options.updated !== undefined ? { updated: options.updated } : {}),
    ...(options.mount !== undefined ? { mount: options.mount } : {}),
    ...(options.staticFallback !== undefined ? { staticFallback: options.staticFallback } : {}),
    // `style` is an extra own-property carried for the Phase 4 client wiring.
    // It is not part of `ServerComponentDefinition`, but the cast below allows
    // it to ride through `defineServerComponent`'s `{ ...definition }` spread.
    ...(options.style !== undefined ? { style: options.style } : {}),
  };

  // `defineServerComponent` validates and normalizes — do not re-implement.
  return defineServerComponent(lowered as unknown as ServerComponentDefinition<State>);
}
