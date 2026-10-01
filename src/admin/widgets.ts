/**
 * Admin widgets: declarative stat cards for the dashboard.
 *
 * `defineWidget(spec)` validates a widget — a URL-safe `name`, a human `label`,
 * and a trusted `render` callback returning a stat value (a string or number)
 * for the current admin session — and returns a frozen {@link Widget}
 * descriptor. A panel declares widgets via `defineAdminPanel({ widgets })`; the
 * admin plugin renders each as a dashboard stat card (label plus the escaped
 * value).
 *
 * The module is ORM-free: it imports only the session contract (a type) and
 * performs no I/O.
 */

import type { Session } from '../contracts/http.js';

/** Context handed to a widget's `render` callback. */
export interface AdminWidgetContext {
  /** The resolved, authorized admin session. */
  readonly session: Session;
  /** The panel base path (e.g. `/admin`). */
  readonly path: string;
}

/** A widget's trusted stat renderer; returns the value to display. */
export type AdminWidgetRender = (
  context: AdminWidgetContext,
) => string | number | Promise<string | number>;

/** A frozen, validated widget descriptor consumed by {@link adminPlugin}. */
export interface Widget {
  /** Unique widget name within a panel. */
  readonly name: string;
  /** Human card label. */
  readonly label: string;
  /** Render the stat value for the current session. */
  readonly render: AdminWidgetRender;
}

/** Specification passed to {@link defineWidget}. */
export interface WidgetDefinition {
  /** Unique widget name within a panel. */
  readonly name: string;
  /** Human card label. */
  readonly label: string;
  /** Render the stat value. */
  readonly render: AdminWidgetRender;
}

/** Raised for invalid widget specs. Messages never embed input values. */
export class WidgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WidgetError';
  }
}

/** Validate a widget spec and return a frozen descriptor. */
export function defineWidget(spec: WidgetDefinition): Widget {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new WidgetError('defineWidget requires a spec object');
  }
  if (typeof spec.name !== 'string' || spec.name.trim() === '') {
    throw new WidgetError('widget name must be a non-empty string');
  }
  if (typeof spec.label !== 'string' || spec.label.trim() === '') {
    throw new WidgetError('widget label must be a non-empty string');
  }
  if (typeof spec.render !== 'function') {
    throw new WidgetError('widget must define a render function');
  }
  return Object.freeze({ name: spec.name, label: spec.label, render: spec.render });
}

// ---------------------------------------------------------------------------
// Progress widget
// ---------------------------------------------------------------------------

/** Specification for {@link defineProgressWidget}. */
export interface ProgressWidgetDefinition {
  readonly name: string;
  readonly label: string;
  readonly value: (context: AdminWidgetContext) => number | Promise<number>;
  readonly max?: number;
}

/** Validate a progress-widget spec and return a frozen descriptor. */
export function defineProgressWidget(spec: ProgressWidgetDefinition): Widget {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new WidgetError('defineProgressWidget requires a spec object');
  }
  if (typeof spec.name !== 'string' || spec.name.trim() === '') {
    throw new WidgetError('widget name must be a non-empty string');
  }
  if (typeof spec.label !== 'string' || spec.label.trim() === '') {
    throw new WidgetError('widget label must be a non-empty string');
  }
  if (typeof spec.value !== 'function') {
    throw new WidgetError('progress widget must define a value function');
  }
  if (spec.max !== undefined) {
    if (typeof spec.max !== 'number' || spec.max <= 0 || !Number.isFinite(spec.max)) {
      throw new WidgetError('progress widget max must be a positive number');
    }
  }

  return Object.freeze({
    name: spec.name,
    label: spec.label,
    render: async (context: AdminWidgetContext): Promise<string | number> => {
      const value = await spec.value(context);
      if (spec.max !== undefined) {
        return `${Math.round((value / spec.max) * 100)}%`;
      }
      return value;
    },
  });
}

// ---------------------------------------------------------------------------
// List widget
// ---------------------------------------------------------------------------

/** Specification for {@link defineListWidget}. */
export interface ListWidgetDefinition {
  readonly name: string;
  readonly label: string;
  readonly items: (context: AdminWidgetContext) => readonly string[] | Promise<readonly string[]>;
}

/** Validate a list-widget spec and return a frozen descriptor. */
export function defineListWidget(spec: ListWidgetDefinition): Widget {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new WidgetError('defineListWidget requires a spec object');
  }
  if (typeof spec.name !== 'string' || spec.name.trim() === '') {
    throw new WidgetError('widget name must be a non-empty string');
  }
  if (typeof spec.label !== 'string' || spec.label.trim() === '') {
    throw new WidgetError('widget label must be a non-empty string');
  }
  if (typeof spec.items !== 'function') {
    throw new WidgetError('list widget must define an items function');
  }

  return Object.freeze({
    name: spec.name,
    label: spec.label,
    render: async (context: AdminWidgetContext): Promise<string> => {
      const items = await spec.items(context);
      return items.join(', ');
    },
  });
}

// ---------------------------------------------------------------------------
// Trend widget
// ---------------------------------------------------------------------------

/** Specification for {@link defineTrendWidget}. */
export interface TrendWidgetDefinition {
  readonly name: string;
  readonly label: string;
  readonly value: (context: AdminWidgetContext) => number | Promise<number>;
  readonly delta: (context: AdminWidgetContext) => number | Promise<number>;
}

/** Validate a trend-widget spec and return a frozen descriptor. */
export function defineTrendWidget(spec: TrendWidgetDefinition): Widget {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new WidgetError('defineTrendWidget requires a spec object');
  }
  if (typeof spec.name !== 'string' || spec.name.trim() === '') {
    throw new WidgetError('widget name must be a non-empty string');
  }
  if (typeof spec.label !== 'string' || spec.label.trim() === '') {
    throw new WidgetError('widget label must be a non-empty string');
  }
  if (typeof spec.value !== 'function') {
    throw new WidgetError('trend widget must define a value function');
  }
  if (typeof spec.delta !== 'function') {
    throw new WidgetError('trend widget must define a delta function');
  }

  return Object.freeze({
    name: spec.name,
    label: spec.label,
    render: async (context: AdminWidgetContext): Promise<string> => {
      const value = await spec.value(context);
      const delta = await spec.delta(context);
      const sign = delta >= 0 ? '+' : '';
      return `${value} (${sign}${delta})`;
    },
  });
}
