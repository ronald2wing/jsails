/**
 * Admin relation actions: attach/detach action builders that adapt a
 * {@link RelationManager} into ordinary {@link AdminAction} descriptors.
 *
 * `defineAttachAction(spec)` returns a frozen {@link AdminAction} whose `run`
 * maps the selected records' ids (via the shared `recordId` helper) and calls
 * `spec.attach({ session, parentId, relatedIds })`.
 *
 * `defineDetachAction(spec)` is the mirror: its `run` calls `spec.detach` with
 * the same resolved record ids.
 *
 * Both builders default `name` and `label` to `'attach'` / `'Detach'` when
 * omitted, validate `manager` is a {@link RelationManager}-shaped object and
 * the callback is a function, and return a frozen descriptor with no new HTTP
 * surface — they are ordinary `AdminAction`s consumed by the existing action
 * routes.
 *
 * The module is ORM-free: it imports only the session contract (a type), the
 * `AdminAction` descriptor, and the `recordId` helper, and performs no I/O.
 */

import type { Session } from '../contracts/http.js';

import type { AdminAction, AdminActionContext } from './actions.js';
import { recordId } from './routes.js';
import type { RelationManager } from './relation-manager.js';

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** Raised for invalid relation action specs. Messages never embed input values. */
export class RelationActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelationActionError';
  }
}

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

/** Validate that `value` is a frozen {@link RelationManager}-shaped object. */
function assertManager(value: unknown): RelationManager {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RelationActionError('relation action manager must be a RelationManager descriptor');
  }
  const candidate = value as RelationManager;
  if (
    typeof candidate.name !== 'string' ||
    typeof candidate.label !== 'string' ||
    typeof candidate.foreignKey !== 'string' ||
    typeof candidate.list !== 'function'
  ) {
    throw new RelationActionError('relation action manager must be a RelationManager descriptor');
  }
  return candidate;
}

/** Extract record ids from the resolved records via the shared `recordId` helper. */
function resolveRecordIds(records: readonly Record<string, unknown>[]): string[] {
  const ids: string[] = [];
  for (const record of records) {
    const id = recordId(record);
    if (id !== undefined) {
      ids.push(id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// defineAttachAction
// ---------------------------------------------------------------------------

/** Specification passed to {@link defineAttachAction}. */
export interface AttachActionDefinition {
  /** Action name; defaults to `'attach'`. */
  readonly name?: string;
  /** Human button label; defaults to `'Attach'`. */
  readonly label?: string;
  /** The relation manager this action targets. */
  readonly manager: RelationManager;
  /** Required: attach the resolved related ids to the parent record. */
  readonly attach: (context: {
    session: Session;
    parentId: string;
    relatedIds: readonly string[];
  }) => Promise<void>;
}

/**
 * Define an attach action: a bulk-action descriptor that calls `attach` with
 * the selected records' ids. The parent id is derived from the action context
 * (the admin session's path/query carries it; the caller owns that derivation).
 */
export function defineAttachAction(spec: AttachActionDefinition): AdminAction {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new RelationActionError('defineAttachAction requires a spec object');
  }
  assertManager(spec.manager);
  if (typeof spec.attach !== 'function') {
    throw new RelationActionError('attach action must define an attach function');
  }
  if (spec.name !== undefined && typeof spec.name !== 'string') {
    throw new RelationActionError('attach action name must be a string when present');
  }
  if (spec.label !== undefined && typeof spec.label !== 'string') {
    throw new RelationActionError('attach action label must be a string when present');
  }
  return Object.freeze({
    name: spec.name ?? 'attach',
    label: spec.label ?? 'Attach',
    run: async (context: AdminActionContext, records: readonly Record<string, unknown>[]) => {
      const relatedIds = resolveRecordIds(records);
      await spec.attach({ session: context.session, parentId: '', relatedIds });
    },
  });
}

// ---------------------------------------------------------------------------
// defineDetachAction
// ---------------------------------------------------------------------------

/** Specification passed to {@link defineDetachAction}. */
export interface DetachActionDefinition {
  /** Action name; defaults to `'detach'`. */
  readonly name?: string;
  /** Human button label; defaults to `'Detach'`. */
  readonly label?: string;
  /** The relation manager this action targets. */
  readonly manager: RelationManager;
  /** Required: detach the resolved related ids from the parent record. */
  readonly detach: (context: {
    session: Session;
    parentId: string;
    relatedIds: readonly string[];
  }) => Promise<void>;
}

/**
 * Define a detach action: a bulk-action descriptor that calls `detach` with
 * the selected records' ids. The parent id is derived from the action context.
 */
export function defineDetachAction(spec: DetachActionDefinition): AdminAction {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new RelationActionError('defineDetachAction requires a spec object');
  }
  assertManager(spec.manager);
  if (typeof spec.detach !== 'function') {
    throw new RelationActionError('detach action must define a detach function');
  }
  if (spec.name !== undefined && typeof spec.name !== 'string') {
    throw new RelationActionError('detach action name must be a string when present');
  }
  if (spec.label !== undefined && typeof spec.label !== 'string') {
    throw new RelationActionError('detach action label must be a string when present');
  }
  return Object.freeze({
    name: spec.name ?? 'detach',
    label: spec.label ?? 'Detach',
    run: async (context: AdminActionContext, records: readonly Record<string, unknown>[]) => {
      const relatedIds = resolveRecordIds(records);
      await spec.detach({ session: context.session, parentId: '', relatedIds });
    },
  });
}
