/**
 * Polymorphic-relation core: a decorator that registers generic foreign-key
 * columns (a type discriminator + an id) on the owning entity, plus a module-
 * level registry so model-schema conversion and runtime loaders can discover
 * the relation shape without parsing decorators twice.
 *
 * This is a TypeORM layer, not a portable-schema layer. The decorator writes
 * into TypeORM's global `MetadataArgsStorage` so that `convertEntity` sees the
 * type/id columns as ordinary `varchar`/`integer` columns and the table-level
 * descriptor is attached by the model-schema adapter.
 */

import { BaseEntity, getMetadataArgsStorage } from 'typeorm';
import { UnsupportedSchemaError } from './model-schema.js';

// ---------------------------------------------------------------------------
// Descriptor shape
// ---------------------------------------------------------------------------

export interface PolymorphicDescriptor {
  /** The decorated property name (e.g. "target"). */
  propertyName: string;
  /** The generated discriminator column name (e.g. "target_type"). */
  typeColumn: string;
  /** The generated FK column name (e.g. "target_id"). */
  idColumn: string;
  /** The inverse property name on the targeted entities. */
  relatedName: string;
  /** The target entity classes (decorator order is not guaranteed). */
  targetClasses: Function[];
}

// ---------------------------------------------------------------------------
// Registry (module-scoped — Map with Function keys, plus a key track set so
// we can clear entries for tests without losing the WeakMap property that the
// descriptor is dropped when the class is GCed).
// ---------------------------------------------------------------------------

const descriptorRegistry = new WeakMap<Function, PolymorphicDescriptor>();
const registeredKeys = new Set<Function>();

export function resolvePolymorphicDescriptor(entity: Function): PolymorphicDescriptor | undefined {
  return descriptorRegistry.get(entity);
}

/** Reset the module-level registry between tests. */
export function clearPolymorphicRegistry(): void {
  for (const key of registeredKeys) {
    descriptorRegistry.delete(key);
  }
  registeredKeys.clear();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toSnakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Resolve a target class to its table name by scanning the global metadata
 * storage. Falls back to the class name when no table metadata is registered.
 */
function resolveTableName(targetClass: Function): string {
  const storage = getMetadataArgsStorage();
  const tableArg = storage.tables.find((t) => t.target === targetClass);
  return tableArg?.name ?? targetClass.name;
}

// ---------------------------------------------------------------------------
// Decorator
// ---------------------------------------------------------------------------

export function PolymorphicRelation(options: {
  targets: Function[];
  relatedName: string;
  typeColumn?: string;
  idColumn?: string;
}): PropertyDecorator {
  if (!Array.isArray(options.targets) || options.targets.length === 0) {
    throw new Error('PolymorphicRelation: "targets" must be a non-empty array');
  }
  if (typeof options.relatedName !== 'string' || options.relatedName.length === 0) {
    throw new Error('PolymorphicRelation: "relatedName" must be a non-empty string');
  }

  return function (target: object, propertyKey: string | symbol): void {
    if (typeof propertyKey !== 'string') {
      throw new Error('PolymorphicRelation: property must be a string name');
    }

    const baseName = toSnakeCase(propertyKey);
    const typeColumn = options.typeColumn ?? `${baseName}_type`;
    const idColumn = options.idColumn ?? `${baseName}_id`;

    const storage = getMetadataArgsStorage();

    // Register discriminator column (varchar 190, not null).
    storage.columns.push({
      target: target.constructor,
      propertyName: typeColumn,
      mode: 'regular',
      options: { type: 'varchar', length: 190, nullable: false },
    });

    // Register FK column (integer, not null).
    storage.columns.push({
      target: target.constructor,
      propertyName: idColumn,
      mode: 'regular',
      options: { type: 'integer', nullable: false },
    });

    const ctor = target.constructor;
    // TypeScript inference loses Function typing in decorator context; the
    // assertion above restores it for WeakMap/Set usage.
    descriptorRegistry.set(ctor, {
      propertyName: propertyKey,
      typeColumn,
      idColumn,
      relatedName: options.relatedName,
      targetClasses: [...options.targets],
    });
    registeredKeys.add(ctor);
  };
}

// ---------------------------------------------------------------------------
// Runtime loaders
// ---------------------------------------------------------------------------

/**
 * Forward load: child → parent. Reads the type/id discriminator columns on
 * `instance`, resolves the type to a target entity class, and loads the
 * referenced row by primary key. Returns `null` when the type or id is
 * null/undefined (the relation is unset, not an error).
 */
export async function loadPolymorphic<T = unknown>(
  instance: object,
  propertyName: string,
): Promise<T | null> {
  const descriptor = resolvePolymorphicDescriptor(instance.constructor);
  if (!descriptor) {
    throw new Error(
      `loadPolymorphic: no polymorphic descriptor found for ${instance.constructor.name}. ` +
        `Did you decorate property "${propertyName}" with @PolymorphicRelation?`,
    );
  }

  const typeValue = (instance as Record<string, unknown>)[descriptor.typeColumn];
  const idValue = (instance as Record<string, unknown>)[descriptor.idColumn];

  if (typeValue == null || idValue == null) {
    return null;
  }

  if (typeof typeValue !== 'string') {
    throw new Error(
      `loadPolymorphic: type column "${descriptor.typeColumn}" must be a string, ` +
        `got ${typeof typeValue}`,
    );
  }

  const targetClass = descriptor.targetClasses.find((c) => resolveTableName(c) === typeValue);
  if (!targetClass) {
    throw new Error(
      `loadPolymorphic: no target class matches type value "${typeValue}" ` +
        `(available: ${descriptor.targetClasses.map((c) => resolveTableName(c)).join(', ')})`,
    );
  }

  // Use the entity's own repository to find the PK property name and query.
  const EntityClass = targetClass as typeof BaseEntity;
  const repo = EntityClass.getRepository();
  const pkColumn = repo.metadata.primaryColumns[0];
  if (!pkColumn) {
    throw new UnsupportedSchemaError(
      `loadPolymorphic: target entity "${targetClass.name}" has no primary key column`,
    );
  }
  const pkProp = pkColumn.propertyName;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- dynamic PK key requires widening
  const result = await EntityClass.findOneBy({ [pkProp]: idValue } as Record<string, unknown>);
  return (result as T) ?? null;
}

/**
 * Inverse load: parent → children. Finds the child entity whose polymorphic
 * descriptor names `propertyName` as `relatedName` and whose target classes
 * include the instance's table, then queries all child rows that point at this
 * instance. Returns an empty array when no rows exist.
 */
export async function loadPolymorphicInverse<T = unknown>(
  instance: object,
  propertyName: string,
): Promise<T[]> {
  const instanceTableName = resolveTableName(instance.constructor);

  // Find a child entity class that targets this instance's table.
  const storage = getMetadataArgsStorage();
  let childClass: Function | undefined;
  let childDescriptor: PolymorphicDescriptor | undefined;

  for (const tableArg of storage.tables) {
    const candidate = tableArg.target;
    if (typeof candidate !== 'function') continue;
    const desc = resolvePolymorphicDescriptor(candidate);
    if (!desc) continue;
    if (desc.relatedName !== propertyName) continue;

    const targetTableNames = desc.targetClasses.map((c) => resolveTableName(c));
    if (!targetTableNames.includes(instanceTableName)) continue;

    childClass = candidate;
    childDescriptor = desc;
    break;
  }

  if (!childClass || !childDescriptor) {
    throw new Error(
      `loadPolymorphicInverse: no polymorphic child entity found with ` +
        `relatedName="${propertyName}" that targets table "${instanceTableName}"`,
    );
  }

  // Determine the instance's PK value.
  const EntityClass = childClass as typeof BaseEntity;
  const repo = EntityClass.getRepository();
  const pkColumn = repo.metadata.primaryColumns[0];
  if (!pkColumn) {
    throw new UnsupportedSchemaError(
      `loadPolymorphicInverse: could not find primary key for parent entity ` +
        `"${instance.constructor.name}"`,
    );
  }

  // Look up the instance's PK value. The instance might not be a BaseEntity
  // with a typed PK property, so read it via the metadata property name.
  // Use the instance's own entity metadata.
  const InstanceClass = instance.constructor as typeof BaseEntity;
  const instanceRepo = InstanceClass.getRepository();
  const instancePkColumn = instanceRepo.metadata.primaryColumns[0];
  if (!instancePkColumn) {
    throw new UnsupportedSchemaError(
      `loadPolymorphicInverse: parent entity "${instance.constructor.name}" ` +
        `has no primary key column`,
    );
  }
  const instancePkProp = instancePkColumn.propertyName;
  const pkValue = (instance as Record<string, unknown>)[instancePkProp];

  // Query child rows.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- dynamic FK keys need widening
  const result = await EntityClass.findBy({
    [childDescriptor.typeColumn]: instanceTableName,
    [childDescriptor.idColumn]: pkValue,
  } as Record<string, unknown>);
  return (result as T[]) ?? [];
}

/**
 * Synchronous target-class resolution (forward). No I/O, no query.
 */
export function resolvePolymorphicTarget(
  instance: object,
  propertyName: string,
): Function | undefined {
  const descriptor = resolvePolymorphicDescriptor(instance.constructor);
  if (!descriptor) {
    throw new Error(
      `resolvePolymorphicTarget: no polymorphic descriptor found for ` +
        `${instance.constructor.name}. Did you decorate property "${propertyName}"?`,
    );
  }

  const typeValue = (instance as Record<string, unknown>)[descriptor.typeColumn];
  if (typeValue == null) return undefined;
  if (typeof typeValue !== 'string') {
    throw new Error(
      `resolvePolymorphicTarget: type column "${descriptor.typeColumn}" must be a string`,
    );
  }

  return descriptor.targetClasses.find((c) => resolveTableName(c) === typeValue);
}

/**
 * Synchronous child-class resolution (inverse). No I/O, no query.
 */
export function resolvePolymorphicInverse(
  instance: object,
  propertyName: string,
): Function | undefined {
  const instanceTableName = resolveTableName(instance.constructor);
  const storage = getMetadataArgsStorage();

  for (const tableArg of storage.tables) {
    const candidate = tableArg.target;
    if (typeof candidate !== 'function') continue;
    const desc = resolvePolymorphicDescriptor(candidate);
    if (!desc) continue;
    if (desc.relatedName !== propertyName) continue;

    const targetTableNames = desc.targetClasses.map((c) => resolveTableName(c));
    if (targetTableNames.includes(instanceTableName)) {
      return candidate;
    }
  }

  return undefined;
}
