/**
 * Model extraction for the JSails dialect.
 *
 * A JSails model is a class extending `ApplicationRecord` that declares only the
 * shape of its data:
 *
 * ```ts
 * export class Post extends ApplicationRecord {
 *   declare title: string;
 *   declare author: Author;      // -> many-to-one, column author_id -> author
 *   declare comments: Comment[]; // -> one-to-many (inverse)
 * }
 * ```
 *
 * The user writes no TypeORM. This module reads a model source **text** and
 * derives the entity, columns, and relations from the class shape. Types are
 * erased at runtime, so the compiler is the only thing that can read `declare
 * author: Author` — extraction is compiler-driven and convention-based, exactly
 * like {@link resolveComponentTags}.
 *
 * Inference rules (Rails-identical):
 * - `declare title: string` -> `varchar`; `number` -> `integer`; `boolean` ->
 *   `boolean`; `Date` -> `datetime`.
 * - `declare author: Author` -> many-to-one. The FK column derives from the
 *   field name (`author` -> `author_id`); the target table from the type
 *   (`Author` -> `author`).
 * - `declare comments: Comment[]` -> one-to-many (inverse).
 *
 * The one real ambiguity is a self-referential inverse (`children: Category[]`
 * beside `parent: Category`): the type carries no direction, so the inverse
 * cannot be inferred. That case is reported as an `ambiguous_relation`
 * diagnostic and never guessed; the field decorator is the escape hatch.
 *
 * Anything inference cannot read — a union (`Author | null`), a generic
 * (`Array<Author>`), or an imported alias — is reported as an `unresolved_model`
 * diagnostic rather than guessed. A field with an explicit `@jsails.*` relation
 * decorator replaces inference for that field.
 *
 * Pure except for one existence check: no module is imported, no top-level code
 * runs. The check reads the filesystem only to confirm a resolved model file
 * exists.
 */

import { basename, join } from 'node:path';

import { parseSync } from 'rolldown/utils';

import {
  CONVENTION_DIRS,
  MODEL_EXTENSIONS,
  classNameFromFile,
  kebabCase,
  probeConventionFile,
  snakeCase,
} from './conventions.js';

import type { CompilerErrorCode } from './errors.js';

/** The base class a JSails model extends. */
const MODEL_BASE_CLASS = 'ApplicationRecord';

/**
 * The conventional length of a `varchar` column. A `declare title: string` has
 * no length of its own, so it takes the Rails-identical default; `@jsails.maxLength(n)`
 * overrides it. `defineModel` requires an explicit length, so the extractor
 * always resolves one for a varchar.
 */
const DEFAULT_STRING_LENGTH = 255;

/** A scalar column kind, expressed in portable TypeORM column-type terms. */
export type ScalarKind = 'varchar' | 'text' | 'integer' | 'boolean' | 'datetime' | 'json';

/** A relation kind. */
export type RelationKind = 'many-to-one' | 'one-to-many';

/**
 * A parsed decorator argument. An identifier (a class reference) is wrapped as
 * `{ identifier }` so a target name is distinguishable from a string literal;
 * object arguments are plain records of recursively-parsed values.
 */
export type ModelArg =
  | string
  | number
  | boolean
  | null
  | { readonly identifier: string }
  | readonly ModelArg[]
  | { readonly [key: string]: ModelArg };

/** An inline `@jsails.*` decorator on a field. */
export interface FieldDecorator {
  /** The decorator's property name without the namespace, e.g. `maxLength`. */
  readonly name: string;
  /** Positional arguments, parsed into {@link ModelArg}. */
  readonly args: readonly ModelArg[];
}

/** A scalar column field. */
export interface ExtractedColumn {
  readonly field: 'column';
  /** The property name, e.g. `title`. */
  readonly name: string;
  readonly kind: ScalarKind;
  /** For `varchar`, the explicit length; otherwise `undefined`. */
  readonly length?: number;
  /** Whether the column accepts `null` (from `@jsails.nullable()`). */
  readonly nullable?: boolean;
  /** Whether the column carries a unique constraint (from `@jsails.unique()`). */
  readonly unique?: boolean;
  /**
   * A prior column name (from `@jsails.renamedFrom('old_name')`), carried as a
   * side-channel so the schema reconciler can emit a rename instead of drop+add.
   */
  readonly renamedFrom?: string;
  readonly decorators: readonly FieldDecorator[];
  /** Absolute offset of the field's first character in the source. */
  readonly start: number;
  /** Absolute offset just past the field's last character (exclusive). */
  readonly end: number;
}

/** A relation field. */
export interface ExtractedRelation {
  readonly field: 'relation';
  /** The property name, e.g. `author`. */
  readonly name: string;
  readonly kind: RelationKind;
  /** The target class name as written, e.g. `Author`. */
  readonly target: string;
  /** For a many-to-one field, the derived FK column, e.g. `author_id`. */
  readonly foreignKey: string;
  /** For a many-to-one field, whether the FK accepts `null`. */
  readonly nullable?: boolean;
  /** For a many-to-one field, touch the parent's `updated_at` on child change. */
  readonly touch?: boolean;
  /** For a one-to-many field, maintain a `<name>_count` counter cache. */
  readonly counterCache?: boolean;
  /** For a one-to-many field, the inverse property name on the target. */
  readonly inverse?: string;
  /**
   * A prior FK column name (from `@jsails.renamedFrom('old_name')`). Refers to
   * the derived FK column (e.g. `author_id`), not the relation property; the
   * rename-hint builder resolves the physical name.
   */
  readonly renamedFrom?: string;
  readonly decorators: readonly FieldDecorator[];
  readonly start: number;
  readonly end: number;
}

/** One derived field of a model. */
export type ExtractedField = ExtractedColumn | ExtractedRelation;

/** A derived model. */
export interface ExtractedModel {
  /** The class name, e.g. `Post`. */
  readonly className: string;
  /** The table name (snake_case of the class name), e.g. `post`. */
  readonly tableName: string;
  /** The fields, in declaration order. */
  readonly fields: readonly ExtractedField[];
  /**
   * The names of fields marked `@jsails.encrypts()`, in declaration order. The
   * compiler folds these into the spec so `defineModel` can wire the encryption
   * hook for exactly this set.
   */
  readonly encrypted: readonly string[];
}

/**
 * Callback that records a model-resolution diagnostic. The caller owns the
 * message; the reference owns the position, so the diagnostic is pinned to the
 * exact field rather than the whole file.
 */
export interface ModelReporter {
  (code: CompilerErrorCode, message: string, subject: string, start: number, end: number): void;
}

/* ------------------------------------------------------------------ */
/*  ESTree helpers                                                     */
/* ------------------------------------------------------------------ */

type EstreeNode = {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
};

const asNode = (value: unknown): EstreeNode | undefined =>
  value !== null && typeof value === 'object' && typeof (value as EstreeNode).type === 'string'
    ? (value as EstreeNode)
    : undefined;

const asNodeArray = (value: unknown): EstreeNode[] =>
  Array.isArray(value) ? (value as EstreeNode[]) : [];

const nodeName = (node: EstreeNode | undefined): string | undefined =>
  typeof node?.name === 'string' ? node.name : undefined;

/* ------------------------------------------------------------------ */
/*  Public entry                                                       */
/* ------------------------------------------------------------------ */

/**
 * Extract a model from source text.
 *
 * Returns `undefined` when the source declares no class extending
 * `ApplicationRecord` (the source is not a model). Reports a positioned
 * `unparseable` diagnostic and returns `undefined` when the source does not
 * parse. `fileName` is used to parse TypeScript and to derive the class name
 * when the class is anonymous.
 */
export function extractModel(
  source: string,
  fileName: string,
  report: ModelReporter,
): ExtractedModel | undefined {
  let program: EstreeNode;
  try {
    program = parseModule(source, fileName);
  } catch {
    report('unparseable', 'model source could not be parsed', basename(fileName), 0, 0);
    return undefined;
  }

  const classNode = findModelClass(program);
  if (classNode === undefined) {
    return undefined;
  }

  const className = nodeName(asNode(classNode.id)) ?? classNameFromFile(fileName);
  const tableName = snakeCase(className);
  const fields: ExtractedField[] = [];
  const encrypted: string[] = [];

  for (const member of asNodeArray(asNode(classNode.body)?.body)) {
    if (member.type !== 'PropertyDefinition' && member.type !== 'ClassProperty') {
      continue;
    }
    const field = extractField(member, className, report);
    if (field !== undefined) {
      fields.push(field);
      if (field.decorators.some((decorator) => decorator.name === 'encrypts')) {
        encrypted.push(field.name);
      }
    }
  }

  return Object.freeze({
    className,
    tableName,
    fields: Object.freeze(fields),
    encrypted: Object.freeze(encrypted),
  });
}

/**
 * Resolve a model class name to its convention-based module file.
 *
 * `Author` resolves to `<rootDir>/models/author.ts` (kebab-case, existence
 * checked), mirroring {@link resolveComponentTags}. Returns `undefined` when no
 * file exists for the class.
 */
export function resolveModelFile(rootDir: string, className: string): string | undefined {
  const modelsDir = join(rootDir, CONVENTION_DIRS.models);
  return probeConventionFile(modelsDir, kebabCase(className), MODEL_EXTENSIONS);
}

/* ------------------------------------------------------------------ */
/*  Class discovery                                                    */
/* ------------------------------------------------------------------ */

/** Find the first class declaration or default-exported class extending the base. */
function findModelClass(program: EstreeNode): EstreeNode | undefined {
  for (const stmt of asNodeArray(program.body)) {
    let target: EstreeNode | undefined = stmt;
    if (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') {
      target = asNode(stmt.declaration);
    }
    const classNode = asNode(target);
    if (classNode === undefined || classNode.type !== 'ClassDeclaration') {
      continue;
    }
    if (superClassName(classNode) === MODEL_BASE_CLASS) {
      return classNode;
    }
  }
  return undefined;
}

/** The name of a class's superclass expression, or `undefined`. */
function superClassName(classNode: EstreeNode): string | undefined {
  const superClass = asNode(classNode.superClass);
  if (superClass === undefined) {
    return undefined;
  }
  return superClass.type === 'Identifier' ? nodeName(superClass) : undefined;
}

/* ------------------------------------------------------------------ */
/*  Field extraction                                                   */
/* ------------------------------------------------------------------ */

function extractField(
  member: EstreeNode,
  className: string,
  report: ModelReporter,
): ExtractedField | undefined {
  const name = nodeName(asNode(member.key));
  if (name === undefined) {
    return undefined;
  }

  const decorators = parseDecorators(asNodeArray(member.decorators));
  const annotation = asNode(member.typeAnnotation);
  const type = annotation !== undefined ? asNode(annotation.typeAnnotation) : undefined;

  // The explicit escape hatch: a relation decorator, once written, *is* the
  // relation's declaration and replaces inference for this field.
  const explicitRelation = decorators.find((decorator) =>
    ['belongsTo', 'hasMany', 'hasOne'].includes(decorator.name),
  );

  if (explicitRelation !== undefined) {
    return buildRelation(name, explicitRelation, decorators, className, member, report);
  }

  if (type === undefined) {
    report(
      'unresolved_model',
      `field '${name}' has no type annotation to infer from`,
      name,
      member.start,
      member.end,
    );
    return undefined;
  }

  const scalar = scalarKind(type);
  if (scalar !== undefined) {
    return buildColumn(name, scalar.kind, scalar.length, decorators, member);
  }
  const relation = inferRelation(type);
  if (relation !== undefined) {
    return buildRelation(name, undefined, decorators, className, member, report, relation);
  }

  report(
    'unresolved_model',
    `field '${name}' has an unsupported type; annotate it with a @jsails decorator`,
    name,
    member.start,
    member.end,
  );
  return undefined;
}

function buildColumn(
  name: string,
  kind: ScalarKind,
  length: number | undefined,
  decorators: readonly FieldDecorator[],
  member: EstreeNode,
): ExtractedColumn {
  // `@jsails.maxLength(n)` overrides the inferred length; the other column
  // decorators are boolean flags. A decorator that does not apply to a column
  // (a relation decorator) is ignored here — it was already consumed above.
  const maxLength = decoratorNumber(decorators, 'maxLength');
  const resolvedLength =
    maxLength ?? length ?? (kind === 'varchar' ? DEFAULT_STRING_LENGTH : undefined);
  const renamedFrom = decoratorString(decorators, 'renamedFrom');
  return Object.freeze({
    field: 'column',
    name,
    kind,
    ...(resolvedLength !== undefined ? { length: resolvedLength } : {}),
    ...(hasDecorator(decorators, 'nullable') ? { nullable: true } : {}),
    ...(hasDecorator(decorators, 'unique') ? { unique: true } : {}),
    ...(renamedFrom !== undefined ? { renamedFrom } : {}),
    decorators,
    start: member.start,
    end: member.end,
  });
}

function buildRelation(
  name: string,
  explicit: FieldDecorator | undefined,
  decorators: readonly FieldDecorator[],
  className: string,
  member: EstreeNode,
  report: ModelReporter,
  inferred?: { readonly kind: RelationKind; readonly target: string },
): ExtractedRelation | undefined {
  const kind = explicit !== undefined ? explicitRelationKind(explicit.name) : inferred?.kind;
  const target = explicit !== undefined ? explicitRelationTarget(explicit) : inferred?.target;

  if (kind === undefined || target === undefined) {
    report(
      'unresolved_model',
      `field '${name}' has a relation decorator without a resolvable target`,
      name,
      member.start,
      member.end,
    );
    return undefined;
  }

  // The one real ambiguity: a one-to-many whose target is the enclosing class
  // (a self-referential inverse such as `children` beside `parent`). The type
  // carries no direction, so it is reported rather than guessed.
  if (kind === 'one-to-many' && target === className && !hasInverse(explicit)) {
    report(
      'ambiguous_relation',
      `field '${name}' is a self-referential one-to-many; annotate it with @jsails.hasMany(${target}, { inverse: '<field>' })`,
      name,
      member.start,
      member.end,
    );
    return undefined;
  }

  // Relation behaviour flags come from the explicit relation decorator's options
  // object; `nullable` is a standalone `@jsails.nullable()` for both columns and
  // relations, so there is one way to say it.
  const options = explicit?.args[1];
  const optionRecord =
    options !== null && typeof options === 'object' && !Array.isArray(options)
      ? (options as { readonly [key: string]: ModelArg })
      : undefined;
  const inverse = optionRecord?.inverse;
  const nullable = hasDecorator(decorators, 'nullable');
  const renamedFrom = decoratorString(decorators, 'renamedFrom');

  return Object.freeze({
    field: 'relation',
    name,
    kind,
    target,
    foreignKey: `${name}_id`,
    ...(nullable ? { nullable: true } : {}),
    ...(optionRecord?.touch === true ? { touch: true } : {}),
    ...(optionRecord?.counter_cache === true ? { counterCache: true } : {}),
    ...(typeof inverse === 'string' ? { inverse } : {}),
    ...(renamedFrom !== undefined ? { renamedFrom } : {}),
    decorators,
    start: member.start,
    end: member.end,
  });
}

/* ------------------------------------------------------------------ */
/*  Type inference                                                     */
/* ------------------------------------------------------------------ */

/** Map a type node to a scalar kind, or `undefined` when it is not a scalar. */
function scalarKind(type: EstreeNode): { kind: ScalarKind; length?: number } | undefined {
  switch (type.type) {
    case 'TSStringKeyword':
      return { kind: 'varchar' };
    case 'TSNumberKeyword':
      return { kind: 'integer' };
    case 'TSBooleanKeyword':
      return { kind: 'boolean' };
    case 'TSTypeReference': {
      const name = typeName(type);
      if (name === 'Date') {
        return { kind: 'datetime' };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Infer a relation from a type node, or `undefined` when it is not a relation. */
function inferRelation(type: EstreeNode): { kind: RelationKind; target: string } | undefined {
  if (type.type === 'TSTypeReference') {
    const target = typeName(type);
    return target !== undefined && isClassLike(target)
      ? { kind: 'many-to-one', target }
      : undefined;
  }
  if (type.type === 'TSArrayType') {
    const element = asNode(type.elementType);
    if (element !== undefined && element.type === 'TSTypeReference') {
      const target = typeName(element);
      if (target !== undefined && isClassLike(target)) {
        return { kind: 'one-to-many', target };
      }
    }
  }
  return undefined;
}

/** The referenced type's simple name, or `undefined` for a qualified/generic name. */
function typeName(type: EstreeNode): string | undefined {
  const reference = asNode(type.typeName);
  if (reference === undefined) {
    return undefined;
  }
  // A qualified name (`Models.Author`) or a type with parameters is out of scope
  // for v1 convention resolution.
  if (reference.type !== 'Identifier') {
    return undefined;
  }
  // `Array<Comment>` and other generic references parse as a type reference
  // whose `typeArguments`/`typeParameters` hold a `TSTypeParameterInstantiation`
  // object (not an array), so a non-null value means the name is generic.
  if (type.typeArguments != null || type.typeParameters != null) {
    return undefined;
  }
  return nodeName(reference);
}

/** A class-like type name is capitalized (a convention resolution candidate). */
function isClassLike(name: string): boolean {
  return /^[A-Z]/.test(name);
}

/* ------------------------------------------------------------------ */
/*  Decorators                                                         */
/* ------------------------------------------------------------------ */

/** Parse a field's decorators into `{ name, args }` records. */
function parseDecorators(nodes: readonly EstreeNode[]): readonly FieldDecorator[] {
  const decorators: FieldDecorator[] = [];
  for (const decorator of nodes) {
    const expression = asNode(decorator.expression) ?? decorator;
    const decoratorName = decoratorPropertyName(expression);
    if (decoratorName === undefined) {
      continue;
    }
    const args = expression.type === 'CallExpression' ? asNodeArray(expression.arguments) : [];
    decorators.push(
      Object.freeze({
        name: decoratorName,
        args: Object.freeze(args.map(parseArg)),
      }),
    );
  }
  return Object.freeze(decorators);
}

/** The decorator's property name: `@jsails.maxLength` -> `maxLength`; bare `@foo` -> `foo`. */
function decoratorPropertyName(expression: EstreeNode): string | undefined {
  const callee = expression.type === 'CallExpression' ? asNode(expression.callee) : expression;
  if (callee === undefined) {
    return undefined;
  }
  if (callee.type === 'Identifier') {
    return nodeName(callee);
  }
  if (callee.type === 'MemberExpression') {
    return nodeName(asNode(callee.property));
  }
  return undefined;
}

/** Parse a decorator argument into a {@link ModelArg}. */
function parseArg(node: EstreeNode): ModelArg {
  switch (node.type) {
    case 'Literal':
      return literalValue(node);
    case 'Identifier':
      return { identifier: nodeName(node) ?? '' };
    case 'ObjectExpression': {
      const record: Record<string, ModelArg> = {};
      for (const property of asNodeArray(node.properties)) {
        if (property.type !== 'Property') {
          continue;
        }
        const key = nodeName(asNode(property.key));
        const value = asNode(property.value);
        if (key !== undefined && value !== undefined) {
          record[key] = parseArg(value);
        }
      }
      return record;
    }
    case 'ArrayExpression':
      return asNodeArray(node.elements)
        .map((element) => asNode(element))
        .filter((element): element is EstreeNode => element !== undefined)
        .map(parseArg);
    default:
      return null;
  }
}

/** The primitive value of a `Literal` node, or `null` for a non-primitive. */
function literalValue(node: EstreeNode): ModelArg {
  const value = node.value;
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : null;
}

/** Map a relation decorator name to its relation kind. */
function explicitRelationKind(name: string): RelationKind | undefined {
  if (name === 'belongsTo') {
    return 'many-to-one';
  }
  if (name === 'hasMany' || name === 'hasOne') {
    return 'one-to-many';
  }
  return undefined;
}

/** The target class name supplied to a relation decorator. */
function explicitRelationTarget(decorator: FieldDecorator): string | undefined {
  const first = decorator.args[0];
  if (first !== null && typeof first === 'object' && 'identifier' in first) {
    return (first as { readonly identifier: string }).identifier;
  }
  return undefined;
}

/** Whether a relation decorator declares an explicit `inverse`. */
function hasInverse(decorator: FieldDecorator | undefined): boolean {
  if (decorator === undefined) {
    return false;
  }
  const options = decorator.args[1];
  return options !== null && typeof options === 'object' && 'inverse' in options;
}

/** Whether a field carries a decorator with the given name. */
function hasDecorator(decorators: readonly FieldDecorator[], name: string): boolean {
  return decorators.some((decorator) => decorator.name === name);
}

/** The first numeric argument of the named decorator, or `undefined`. */
function decoratorNumber(decorators: readonly FieldDecorator[], name: string): number | undefined {
  const decorator = decorators.find((candidate) => candidate.name === name);
  const first = decorator?.args[0];
  return typeof first === 'number' ? first : undefined;
}

/** The first string argument of the named decorator, or `undefined`. */
function decoratorString(decorators: readonly FieldDecorator[], name: string): string | undefined {
  const decorator = decorators.find((candidate) => candidate.name === name);
  const first = decorator?.args[0];
  return typeof first === 'string' ? first : undefined;
}

/* ------------------------------------------------------------------ */
/*  Parsing / naming                                                   */
/* ------------------------------------------------------------------ */

function parseModule(code: string, fileName: string): EstreeNode {
  const tsFileName = /\.(ts|tsx|mts|mtsx|js|jsx)$/.test(fileName) ? fileName : fileName + '.ts';
  const result = parseSync(tsFileName, code, { sourceType: 'module' });
  if (result.errors.some((error: { severity: string }) => error.severity === 'Error')) {
    throw new Error('model parse failed');
  }
  return result.program as unknown as EstreeNode;
}
