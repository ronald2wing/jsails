/**
 * Render-tool construction for the server-component runtime.
 *
 * `makeRenderTools` builds the `bind`/`call`/`submit`/`poll` helpers (plus the
 * passed-through `errors`/`values`/`context`) handed to a component's `render`.
 * `renderComponentHtml` renders a component's current state inside the owned
 * root element, carrying the snapshot, CSRF, and id markers. Markers and
 * serialized arguments are validated here so a bad tool usage fails the render
 * closed with a value-free {@link ServerComponentRuntimeError}.
 */

import { Fragment, h } from 'preact';
import { z } from 'zod';

import type { JsonValue, RequestContext } from '../../contracts/http.js';
import { renderToString } from '../../jsx/render-to-string.js';
import { isPlainObject } from '../../internal/json-safe.js';
import type {
  ServerComponentAction,
  ServerComponentBindOptions,
  ServerComponentCallAttrs,
  ServerComponentDefinition,
  ServerComponentModelAttrs,
  ServerComponentPollAttrs,
  ServerComponentPollOptions,
  ServerComponentRenderTools,
  ServerComponentState,
  ServerComponentSubmitAttrs,
} from '../component.js';
import {
  ARGS_ATTRIBUTE,
  CALL_ATTRIBUTE,
  COMPONENT_ATTRIBUTE,
  COMPONENT_CSRF_ATTRIBUTE,
  COMPONENT_NAME_ATTRIBUTE,
  COMPONENT_ROOT_ID_PREFIX,
  COMPONENT_SNAPSHOT_ATTRIBUTE,
  DEBOUNCE_ATTRIBUTE,
  MAX_DEBOUNCE_MS,
  MIN_POLL_INTERVAL_MS,
  MODEL_ATTRIBUTE,
  POLL_ATTRIBUTE,
  RULES_ATTRIBUTE,
  SUBMIT_ATTRIBUTE,
  TURBO_ATTRIBUTE,
} from '../protocol.js';
import {
  extractFieldRules,
  serializeFieldRules,
  type FieldValidationRules,
} from '../validation-meta.js';
import {
  confirmAttrs,
  ignoreAttrs,
  intersectAttrs,
  loadingTargetAttrs,
  refAttrs,
  showAttrs,
  sortAttrs,
  textAttrs,
} from '../directives.js';
import { ServerComponentRuntimeError } from './value-errors.js';

/** Wrapper options for rendering a component root to HTML. */
interface RenderHtmlOptions {
  readonly id?: string;
  readonly token?: string;
  readonly csrfToken?: string;
  readonly errors: Readonly<Record<string, string | undefined>>;
  readonly values: Readonly<Record<string, string>>;
  readonly context: RequestContext;
}

/** Look up an action by name without tripping over inherited properties. */
export function lookupAction(
  component: ServerComponentDefinition<any>,
  name: string,
): ServerComponentAction<any, any> | undefined {
  const actions = component.actions;
  if (actions === undefined || !Object.hasOwn(actions, name)) {
    return undefined;
  }
  return actions[name];
}

/** Stringify a bound state value for an element's `value` attribute. */
function serializeStateValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return JSON.stringify(value);
}

/** Serialize args for a `call`/`submit` marker, validating against the action. */
function serializeActionArgs(
  component: ServerComponentDefinition<any>,
  action: string,
  args: JsonValue | undefined,
): string | undefined {
  const definition = lookupAction(component, action);
  if (definition === undefined) {
    throw new ServerComponentRuntimeError('unknown component action');
  }
  if (args === undefined) {
    return undefined;
  }
  if (definition.input === undefined) {
    if (isPlainObject(args) && Object.keys(args).length > 0) {
      throw new ServerComponentRuntimeError('action does not accept arguments');
    }
    return undefined;
  }
  const parsed = definition.input.safeParse(args);
  if (!parsed.success) {
    throw new ServerComponentRuntimeError('invalid action arguments');
  }
  return JSON.stringify(parsed.data);
}

/** Build the `bind`/`call`/`submit` tools handed to a component's `render`. */
function makeRenderTools(
  component: ServerComponentDefinition<any>,
  state: ServerComponentState,
  errors: Readonly<Record<string, string | undefined>>,
  values: Readonly<Record<string, string>>,
  context: RequestContext,
): ServerComponentRenderTools<any> {
  // Field validation rules are extracted lazily (once per field) from the
  // state schema's shape. An oversized schema constraint throws a value-free
  // `ValidationMetaError` here, failing the render closed rather than emitting
  // truncated metadata.
  const rulesByField = new Map<string, FieldValidationRules>();
  const rulesFor = (name: string): FieldValidationRules => {
    const cached = rulesByField.get(name);
    if (cached !== undefined) {
      return cached;
    }
    const shape = (component.stateSchema as z.ZodObject<any>).shape;
    const fieldSchema = shape[name] as z.ZodType | undefined;
    const rules =
      fieldSchema === undefined
        ? ({ required: false } satisfies FieldValidationRules)
        : extractFieldRules(fieldSchema);
    rulesByField.set(name, rules);
    return rules;
  };

  const bind = (
    name: keyof ServerComponentState & string,
    options?: ServerComponentBindOptions,
  ): ServerComponentModelAttrs => {
    const value = state[name];
    const attrs: Record<string, unknown> = { [MODEL_ATTRIBUTE]: name };
    if (typeof value === 'boolean') {
      attrs.checked = value;
    } else {
      attrs.value = serializeStateValue(value);
    }
    if (options?.debounceMs !== undefined) {
      const debounceMs = options.debounceMs;
      if (!Number.isSafeInteger(debounceMs) || debounceMs < 1 || debounceMs > MAX_DEBOUNCE_MS) {
        throw new ServerComponentRuntimeError('invalid debounce duration');
      }
      attrs[DEBOUNCE_ATTRIBUTE] = String(debounceMs);
    }
    const rules = rulesFor(name);
    if (rules.type === 'email' || rules.type === 'number' || rules.type === 'date') {
      attrs.type = rules.type;
    }
    const serializedRules = serializeFieldRules(rules);
    if (serializedRules !== undefined) {
      attrs[RULES_ATTRIBUTE] = serializedRules;
    }
    return attrs as unknown as ServerComponentModelAttrs;
  };

  const call = (action: string, args?: JsonValue): ServerComponentCallAttrs => {
    const serialized = serializeActionArgs(component, action, args);
    return {
      [CALL_ATTRIBUTE]: action,
      ...(serialized === undefined ? {} : { [ARGS_ATTRIBUTE]: serialized }),
    };
  };

  const submit = (action: string, args?: JsonValue): ServerComponentSubmitAttrs => {
    const serialized = serializeActionArgs(component, action, args);
    return {
      [SUBMIT_ATTRIBUTE]: action,
      [TURBO_ATTRIBUTE]: false,
      ...(serialized === undefined ? {} : { [ARGS_ATTRIBUTE]: serialized }),
    };
  };

  const poll = (options: ServerComponentPollOptions): ServerComponentPollAttrs => {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < MIN_POLL_INTERVAL_MS) {
      throw new ServerComponentRuntimeError('invalid poll interval');
    }
    const serialized = JSON.stringify({
      intervalMs: options.intervalMs,
      ...(options.pauseWhenHidden === undefined
        ? {}
        : { pauseWhenHidden: options.pauseWhenHidden }),
      ...(options.pauseWhenOffline === undefined
        ? {}
        : { pauseWhenOffline: options.pauseWhenOffline }),
    });
    return { [POLL_ATTRIBUTE]: serialized };
  };

  // Computed properties are resolved lazily and memoized per render: a repeated
  // access returns the same value (or the same Promise) without re-evaluating.
  const computedCache = new Map<string, unknown>();
  const computed = (name: string): unknown => {
    const definitions = component.computed;
    if (definitions === undefined || !Object.hasOwn(definitions, name)) {
      throw new ServerComponentRuntimeError('unknown computed property');
    }
    if (computedCache.has(name)) {
      return computedCache.get(name);
    }
    const fn = definitions[name];
    if (fn === undefined) {
      throw new ServerComponentRuntimeError('unknown computed property');
    }
    const result = fn(state, context);
    computedCache.set(name, result);
    return result;
  };

  return {
    bind,
    call,
    submit,
    poll,
    computed,
    errors,
    values,
    context,
    confirm: confirmAttrs,
    loadingTarget: loadingTargetAttrs,
    show: showAttrs,
    text: textAttrs,
    sort: sortAttrs,
    intersect: intersectAttrs,
    ref: refAttrs,
    ignore: ignoreAttrs,
  };
}

/** Render a component's current state inside the owned root element. */
export async function renderComponentHtml(
  component: ServerComponentDefinition<any>,
  state: ServerComponentState,
  options: RenderHtmlOptions,
): Promise<string> {
  const tools = makeRenderTools(component, state, options.errors, options.values, options.context);
  const children = await component.render(state, tools);

  const attrs: Record<string, unknown> = {
    [COMPONENT_ATTRIBUTE]: component.name,
    [COMPONENT_NAME_ATTRIBUTE]: component.name,
  };
  if (options.id !== undefined && options.token !== undefined) {
    attrs.id = COMPONENT_ROOT_ID_PREFIX + options.id;
    attrs[COMPONENT_SNAPSHOT_ATTRIBUTE] = options.token;
    attrs[COMPONENT_CSRF_ATTRIBUTE] = options.csrfToken;
  }

  return renderToString(h('div', attrs, h(Fragment, null, children)));
}
