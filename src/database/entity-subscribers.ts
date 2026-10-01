/**
 * Typed, per-entity lifecycle hooks delivered as a TypeORM entity subscriber.
 *
 * {@link defineEntityHooks} declares the hooks for one entity; {@link
 * createEntitySubscriber} compiles one or more such declarations into a single
 * `@EventSubscriber()` class that {@link JsailsDataSource} (and, through it,
 * TypeORM's `DataSource`) can include through its `subscribers` option:
 *
 * ```ts
 * import { JsailsDataSource, defineEntityHooks, createEntitySubscriber } from 'jsails';
 *
 * const hooks = defineEntityHooks(User, {
 *   beforeInsert({ entity, manager }) { /* mutate entity, or use manager *\/ },
 *   afterUpdate({ entity, data, changedColumns }) { /* audit the change *\/ },
 * });
 *
 * const dataSource = new JsailsDataSource({
 *   // ...entities, driver, etc.
 *   subscribers: [createEntitySubscriber(hooks)],
 * });
 * ```
 *
 * Hooks run in declaration order and are awaited, so an async hook can perform
 * its own work (including queries through the transaction-scoped `manager`)
 * before the next hook or the statement itself proceeds. A hook that throws
 * rejects the caller's `save`/`remove`/`find` and aborts the transaction; the
 * error is surfaced unchanged (TypeORM's broadcaster awaits the subscriber
 * promises before/after the DML).
 *
 * The mapping onto TypeORM's subscriber events is deliberately narrow. Hooks
 * fire for the Active Record subject path — `save` (insert/update), `remove`
 * (delete), and entity loads — which is the surface the portable schema model
 * exercises. Query-builder `insert`/`update`/`delete` bypass the subject
 * executor and therefore do not fire hooks.
 *
 * There is no global or module-level state: every {@link createEntitySubscriber}
 * call builds a fresh class closing over its own compiled registry, so two data
 * sources in the same process never share hook state.
 */

import { EntitySchema, EventSubscriber } from 'typeorm';
import type {
  EntityManager,
  EntitySubscriberInterface,
  EntityTarget,
  InsertEvent,
  LoadEvent,
  ObjectLiteral,
  RemoveEvent,
  UpdateEvent,
} from 'typeorm';
import type { Awaitable } from '../internal/types.js';

/** The lifecycle events a hook can subscribe to. */
export type EntityHookEvent =
  | 'beforeInsert'
  | 'afterInsert'
  | 'beforeUpdate'
  | 'afterUpdate'
  | 'beforeDelete'
  | 'afterDelete'
  | 'afterLoad';

/**
 * Context passed to every hook.
 *
 * `entity` is the entity instance the event concerns. For update events it is
 * the pre-change database snapshot (with its generated id and prior values),
 * so a hook can compare stable fields against the incoming `data`. `data` is
 * the partial attribute data being written (the new values on update, the
 * entity itself on insert/delete/load). `changedColumns` names the entity
 * properties an update modified; it is present only for update events.
 */
export interface EntityHookContext<Entity extends ObjectLiteral> {
  /** The entity instance the event concerns (pre-change snapshot on update). */
  readonly entity: Entity;
  /** The partial attribute data being written or read by this event. */
  readonly data: Partial<Entity>;
  /** The entity manager scoped to the event's transaction. */
  readonly manager: EntityManager;
  /** Property names of columns changed by an update (update events only). */
  readonly changedColumns?: readonly string[];
}

/** A single lifecycle hook: an async-or-sync function of the hook context. */
export type EntityHook<Entity extends ObjectLiteral> = (
  context: EntityHookContext<Entity>,
) => Awaitable<void>;

/**
 * The optional hooks for one entity, keyed by lifecycle event. Declared with
 * method syntax so the parameter type is bivariant: a `User`-scoped hook
 * declaration widens cleanly to an `ObjectLiteral`-scoped one, letting
 * {@link createEntitySubscriber} combine declarations of distinct entity types
 * into a single subscriber.
 */
export interface EntityHooks<Entity extends ObjectLiteral> {
  beforeInsert?(context: EntityHookContext<Entity>): Awaitable<void>;
  afterInsert?(context: EntityHookContext<Entity>): Awaitable<void>;
  beforeUpdate?(context: EntityHookContext<Entity>): Awaitable<void>;
  afterUpdate?(context: EntityHookContext<Entity>): Awaitable<void>;
  beforeDelete?(context: EntityHookContext<Entity>): Awaitable<void>;
  afterDelete?(context: EntityHookContext<Entity>): Awaitable<void>;
  afterLoad?(context: EntityHookContext<Entity>): Awaitable<void>;
}

/** Raised for an invalid hooks declaration. Messages are value-free. */
export class EntityHooksError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityHooksError';
  }
}

/**
 * An immutable, validated hook declaration for one entity: the entity target
 * plus its handlers. Produced by {@link defineEntityHooks} and consumed by
 * {@link createEntitySubscriber}.
 */
export interface EntityHooksDefinition<Entity extends ObjectLiteral> {
  readonly entity: EntityTarget<Entity>;
  readonly hooks: Readonly<EntityHooks<Entity>>;
}

/** The constructor shape of the subscriber class returned by {@link createEntitySubscriber}. */
export type EntitySubscriberClass = new () => EntitySubscriberInterface<ObjectLiteral>;

/** An internal compiled hook entry: one event handler for one entity. */
interface HookEntry {
  readonly event: EntityHookEvent;
  readonly hook: EntityHook<ObjectLiteral>;
}

const HOOK_EVENTS: readonly EntityHookEvent[] = [
  'beforeInsert',
  'afterInsert',
  'beforeUpdate',
  'afterUpdate',
  'beforeDelete',
  'afterDelete',
  'afterLoad',
];

/**
 * Declare the lifecycle hooks for a single entity. Returns an immutable,
 * validated definition; combine several definitions by passing them all to
 * {@link createEntitySubscriber}. A handler that is not a function is rejected
 * with an {@link EntityHooksError} before any data source is constructed.
 */
export function defineEntityHooks<Entity extends ObjectLiteral>(
  entity: EntityTarget<Entity>,
  hooks: EntityHooks<Entity>,
): EntityHooksDefinition<Entity> {
  assertEntityTarget(entity);
  assertHooksObject(hooks, 'defineEntityHooks');
  const record = hooks as Record<EntityHookEvent, EntityHook<Entity>>;
  const copied: Record<EntityHookEvent, EntityHook<Entity>> = {} as Record<
    EntityHookEvent,
    EntityHook<Entity>
  >;
  for (const event of HOOK_EVENTS) {
    const hook = record[event];
    if (hook !== undefined) {
      copied[event] = hook;
    }
  }
  return Object.freeze({ entity, hooks: Object.freeze(copied) });
}

/**
 * Compile one or more {@link defineEntityHooks} declarations into a TypeORM
 * entity subscriber class suitable for a data source's `subscribers` option.
 * Multiple declarations for the same entity run in the order they are given.
 *
 * The returned class is decorated with `@EventSubscriber()`, which TypeORM
 * requires for any subscriber listed under `options.subscribers`. Each call
 * builds a distinct class closing over its own registry, so hook state never
 * leaks between data sources.
 */
export function createEntitySubscriber(
  ...definitions: readonly EntityHooksDefinition<ObjectLiteral>[]
): EntitySubscriberClass {
  const registry = new Map<unknown, HookEntry[]>();
  for (const definition of definitions) {
    assertDefinition(definition);
    const key = entityKey(definition.entity);
    const entries = registry.get(key) ?? [];
    for (const event of HOOK_EVENTS) {
      const hook = definition.hooks[event];
      if (hook !== undefined) {
        entries.push({ event, hook });
      }
    }
    registry.set(key, entries);
  }

  @EventSubscriber()
  class JsailsEntityHooksSubscriber {
    beforeInsert(event: InsertEvent<ObjectLiteral>): Awaitable<void> {
      return run(registry, 'beforeInsert', event, {
        entity: event.entity,
        data: event.entity,
        manager: event.manager,
      });
    }

    afterInsert(event: InsertEvent<ObjectLiteral>): Awaitable<void> {
      return run(registry, 'afterInsert', event, {
        entity: event.entity,
        data: event.entity,
        manager: event.manager,
      });
    }

    beforeUpdate(event: UpdateEvent<ObjectLiteral>): Awaitable<void> {
      return run(registry, 'beforeUpdate', event, updateContext(event));
    }

    afterUpdate(event: UpdateEvent<ObjectLiteral>): Awaitable<void> {
      return run(registry, 'afterUpdate', event, updateContext(event));
    }

    beforeRemove(event: RemoveEvent<ObjectLiteral>): Awaitable<void> {
      return run(registry, 'beforeDelete', event, removeContext(event));
    }

    afterRemove(event: RemoveEvent<ObjectLiteral>): Awaitable<void> {
      return run(registry, 'afterDelete', event, removeContext(event));
    }

    afterLoad(entity: ObjectLiteral, event: LoadEvent<ObjectLiteral>): Awaitable<void> {
      return run(registry, 'afterLoad', event, {
        entity,
        data: entity,
        manager: event.manager,
      });
    }
  }

  return JsailsEntityHooksSubscriber;
}

/**
 * Resolve the registry key for an entity target. A class (or an EntitySchema
 * bound to one) is keyed by the constructor identity so two same-named classes
 * in one process stay distinct; a schema without a target and a plain name are
 * keyed by the entity name, which is what the event metadata carries.
 */
function entityKey(entity: EntityTarget<unknown>): unknown {
  if (typeof entity === 'function') {
    return entity;
  }
  if (typeof entity === 'string') {
    return entity;
  }
  if (entity instanceof EntitySchema) {
    const target = entity.options.target;
    return typeof target === 'function' ? target : entity.options.name;
  }
  return entity.name;
}

/** Build the context for an update event, deriving `changedColumns`. */
function updateContext(event: UpdateEvent<ObjectLiteral>): EntityHookContext<ObjectLiteral> {
  return {
    entity: event.databaseEntity ?? event.entity ?? {},
    data: event.entity ?? {},
    manager: event.manager,
    changedColumns: event.updatedColumns.map((column) => column.propertyName),
  };
}

/** Build the context for a remove event (which may be fired without a loaded entity). */
function removeContext(event: RemoveEvent<ObjectLiteral>): EntityHookContext<ObjectLiteral> {
  const entity = event.databaseEntity ?? event.entity;
  return { entity, data: entity, manager: event.manager };
}

/**
 * Run every hook registered for the event's entity, in declaration order. The
 * event metadata supplies the lookup key; a miss is a cheap no-op (the
 * subscriber listens to every entity and filters internally).
 */
async function run(
  registry: ReadonlyMap<unknown, HookEntry[]>,
  eventName: EntityHookEvent,
  event: { metadata: { target: Function | string; name: string } },
  context: EntityHookContext<ObjectLiteral>,
): Promise<void> {
  const entries = registry.get(event.metadata.target) ?? registry.get(event.metadata.name);
  if (entries === undefined) {
    return;
  }
  for (const entry of entries) {
    if (entry.event === eventName) {
      await entry.hook(context);
    }
  }
}

function assertEntityTarget(
  entity: unknown,
  label = 'defineEntityHooks',
): asserts entity is EntityTarget<ObjectLiteral> {
  const valid =
    typeof entity === 'function' ||
    typeof entity === 'string' ||
    entity instanceof EntitySchema ||
    (typeof entity === 'object' &&
      entity !== null &&
      typeof (entity as { name?: unknown }).name === 'string');
  if (!valid) {
    throw new EntityHooksError(
      `${label}: "entity" must be a class, an EntitySchema, or an entity name`,
    );
  }
}

function assertHooksObject(hooks: unknown, label: string): void {
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) {
    throw new EntityHooksError(`${label}: "hooks" must be an object`);
  }
  const record = hooks as Record<EntityHookEvent, unknown>;
  for (const event of HOOK_EVENTS) {
    const hook = record[event];
    if (hook !== undefined && typeof hook !== 'function') {
      throw new EntityHooksError(`${label}: hook "${event}" must be a function`);
    }
  }
}

function assertDefinition(
  definition: unknown,
): asserts definition is EntityHooksDefinition<ObjectLiteral> {
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new EntityHooksError('createEntitySubscriber: every definition must be an object');
  }
  const record = definition as { entity?: unknown; hooks?: unknown };
  assertEntityTarget(record.entity, 'createEntitySubscriber');
  assertHooksObject(record.hooks, 'createEntitySubscriber');
}
