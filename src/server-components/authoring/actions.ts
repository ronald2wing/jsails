/**
 * Action capability split: local (client-runnable, sync, no request context)
 * versus server (round-tripped, async, full context).
 *
 * Local actions are structurally pure: `run` is synchronous and takes no
 * `RequestContext`. This is the guarantee that a local action cannot reach the
 * database, session, or authorization boundary — it can only compute a new
 * state from the existing state and its explicit args.
 *
 * Server actions are the existing `ServerComponentAction` contract with an
 * explicit `kind: 'server'` discriminator so the authoring layer can lower them
 * to the runtime's action shape exactly once, without an extra wrapping layer
 * per update.
 */

import { z } from 'zod';

import type { RequestContext } from '../../contracts/http.js';
import type {
  ServerComponentAction,
  ServerComponentActionInput,
  ServerComponentRedirect,
  ServerComponentState,
} from '../component.js';
import { defineAction } from '../component.js';
import type { ServerComponentDownload } from '../downloads.js';

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/** Raised when an authoring-layer operation receives an invalid input. Value-free. */
export class AuthoringError extends Error {
  readonly code: AuthoringErrorCode;

  constructor(message: string, code: AuthoringErrorCode) {
    super(message);
    this.name = 'AuthoringError';
    this.code = code;
  }
}

/** Stable machine codes carried on an {@link AuthoringError}. */
export type AuthoringErrorCode =
  'local_action_authorize' | 'invalid_actions' | 'invalid_action_kind';

// ---------------------------------------------------------------------------
// Action kinds
// ---------------------------------------------------------------------------

/** The capability split: a local action never reaches the server round-trip. */
export type ActionKind = 'local' | 'server';

// ---------------------------------------------------------------------------
// Local action
// ---------------------------------------------------------------------------

/** A client-runnable action: synchronous, no request context, no I/O. */
export interface LocalAction<State extends ServerComponentState, Args = undefined> {
  readonly kind: 'local';
  readonly input?: z.ZodObject<any>;
  run(state: State, args: Args): void;
}

/**
 * Define a client-runnable action. `run` is synchronous and receives no
 * `RequestContext` — this is the structural purity guarantee.
 *
 * An explicit `authorize` key is rejected: a local action never round-trips,
 * so authorization belongs at the component level.
 */
export function localAction<
  State extends ServerComponentState,
  const I extends z.ZodObject<any> | undefined = undefined,
>(spec: {
  input?: I;
  run(state: State, args: ServerComponentActionInput<I>): void;
}): LocalAction<State, ServerComponentActionInput<I>> {
  if ('authorize' in spec) {
    throw new AuthoringError('a local action must not declare authorize', 'local_action_authorize');
  }

  const action: LocalAction<State, ServerComponentActionInput<I>> = {
    kind: 'local',
    run: spec.run,
  };
  if (spec.input !== undefined) {
    // `input` is optional on the `LocalAction` descriptor but the schema is
    // captured for the runtime; the frozen descriptor is widened through the
    // cast because `input` is deliberately absent from the public type.
    (action as { input?: unknown }).input = spec.input;
  }
  return Object.freeze(action);
}

// ---------------------------------------------------------------------------
// Server action
// ---------------------------------------------------------------------------

/**
 * A round-tripped action: async, full `RequestContext`, optional per-action
 * `authorize`.
 */
export interface ServerAction<State extends ServerComponentState, Args = undefined> {
  readonly kind: 'server';
  readonly input?: z.ZodObject<any>;
  authorize?(context: RequestContext, state: State, args: Args): boolean | Promise<boolean>;
  run(
    state: State,
    args: Args,
    context: RequestContext,
  ):
    | void
    | ServerComponentRedirect
    | ServerComponentDownload
    | Promise<void | ServerComponentRedirect | ServerComponentDownload>;
}

/**
 * Define a server action that round-trips through the runtime.
 * `authorize` is optional and further restricts the component-level policy.
 */
export function serverAction<
  State extends ServerComponentState,
  const I extends z.ZodObject<any> | undefined = undefined,
>(spec: {
  input?: I;
  authorize?(
    context: RequestContext,
    state: State,
    args: ServerComponentActionInput<I>,
  ): boolean | Promise<boolean>;
  run(
    state: State,
    args: ServerComponentActionInput<I>,
    context: RequestContext,
  ):
    | void
    | ServerComponentRedirect
    | ServerComponentDownload
    | Promise<void | ServerComponentRedirect | ServerComponentDownload>;
}): ServerAction<State, ServerComponentActionInput<I>> {
  const action: Record<string, unknown> = { kind: 'server', run: spec.run };
  if (spec.input !== undefined) {
    action.input = spec.input;
  }
  if (spec.authorize !== undefined) {
    action.authorize = spec.authorize;
  }
  return Object.freeze(action) as unknown as ServerAction<State, ServerComponentActionInput<I>>;
}

// ---------------------------------------------------------------------------
// Lowering
// ---------------------------------------------------------------------------

/**
 * Lower a map of authoring-layer actions into the runtime's
 * `ServerComponentAction` shape, preserving each action's `kind` as an
 * own-property so it survives `defineServerComponent` normalization.
 *
 * For local actions the lowered `run` matches the 3-arg signature but ignores
 * the context, keeping the runtime's action-dispatcher interface unchanged.
 * For server actions the action is lowered through `defineAction` for typing,
 * and `kind: 'server'` is attached as an own-property.
 */
export function lowerActions(
  actions: Readonly<Record<string, LocalAction<any, any> | ServerAction<any, any>>>,
): Readonly<Record<string, ServerComponentAction<any, any> & { readonly kind: ActionKind }>> {
  const prototype = Object.getPrototypeOf(actions);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AuthoringError('actions must be a plain object literal', 'invalid_actions');
  }

  const lowered: Record<string, ServerComponentAction<any, any> & { readonly kind: ActionKind }> =
    {};

  for (const [name, action] of Object.entries(actions)) {
    if (action.kind === 'local') {
      const { run, input } = action;
      const entry: Record<string, unknown> = {
        kind: 'local' as const,
        run: (state: any, _args: any, _context: RequestContext) => {
          run(state, _args);
        },
      };
      if (input !== undefined) {
        entry.input = input;
      }
      lowered[name] = entry as unknown as ServerComponentAction<any, any> & {
        readonly kind: ActionKind;
      };
    } else if (action.kind === 'server') {
      const { run, input, authorize } = action;
      const throughDefine = defineAction({
        input,
        authorize,
        run,
      });
      // `defineAction` returns the definition verbatim; attach `kind` as an
      // own-property.  When `normalizeAction` later spreads the action (with or
      // without `.strict()`), the extra `kind` key is preserved because the
      // spread copies every own-property.
      lowered[name] = {
        ...(throughDefine as unknown as Record<string, unknown>),
        kind: 'server' as const,
      } as unknown as ServerComponentAction<any, any> & { readonly kind: ActionKind };
    } else {
      throw new AuthoringError('action kind must be "local" or "server"', 'invalid_action_kind');
    }
  }

  return Object.freeze(lowered);
}
