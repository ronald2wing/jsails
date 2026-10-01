---
title: Server Components
order: 6
---

# Server Components

`jsails/server-components` brings Livewire-style interactive UI to JSails pages.
A server component is **stateless on the server**: its state travels to the
client inside a signed snapshot and back on every update, so the server keeps no
session-side UI store. The subpath is **server-only** — it imports `node:crypto`
and Preact — and it is mounted through an extension plugin.

## Defining a component

Define a component with `defineServerComponent` and its actions with
`defineAction`. The registry key is the component `name`.

```tsx
// components/task-list.tsx  (app-owned; server-only module)
import { z } from 'zod';
import { defineAction, defineServerComponent } from 'jsails/server-components';

const stateSchema = z
  .object({ title: z.string().max(120), tasks: z.array(z.string().min(1)).max(50) })
  .strict();

export const taskList = defineServerComponent<z.infer<typeof stateSchema>>({
  name: 'task-list',
  stateSchema,
  writableKeys: ['title'], // only the bound input is client-writable
  initialState: () => ({ title: '', tasks: [] }),
  authorize: (context) => context.session !== null, // default-deny; exact true
  actions: {
    add: defineAction({
      input: z.object({}), // explicit args, separate from bound state
      run(state) {
        const parsed = z
          .object({ title: z.string().trim().min(1) })
          .safeParse({ title: state.title });
        if (!parsed.success) throw parsed.error; // mapped to a 422 field error
        state.tasks.push(parsed.data.title);
        state.title = '';
      },
    }),
  },
  render(state, { bind, submit, errors }) {
    return (
      <form {...submit('add')}>
        <input {...bind('title')} />
        {errors.title ? <p role="alert">{errors.title}</p> : null}
        <button type="submit">Add</button>
      </form>
    );
  },
  // Static export renders only this: no state, no signing, no actions.
  staticFallback: () => <p>The live task list is unavailable in the static export.</p>,
});
```

Components are persisted and validated against `stateSchema`, a Zod object forced
to `.strict()`. It is the single source of truth for stored state.

## `writableKeys` — what the client may edit

`writableKeys` names **only** the top-level fields a client update may set
(default: none; every entry must be a real top-level field). This restricts
*client* edits only: actions run server-side and may change **any** schema-valid
field regardless of `writableKeys`. In `task-list`, the bound `title` input is
editable, while `tasks` is mutated only by the `add` action.

## `authorize` and action `input`

`authorize(context)` is **required** and default-deny — an exact `true` allows;
a truthy non-boolean, a throw, and a rejection all deny. An action may add its
own `authorize(context, state, input)`.

An action's `input` is a Zod schema for a **separate args object**, parsed and
passed to `run(state, args, context)` — it is never derived from an assumed
`FormData` shape. `task-list` declares `input: z.object({})`, while the trimmed
title is validated from bound state inside `run`.

## Rendering with `bind`, `call`, `submit`

`render(state, tools)` receives three helpers that return attribute maps to
spread onto elements:

- `bind(name)` — two-way bind a state field to a control.
- `call(action, args?)` — a client action round-trip.
- `submit(action, args?)` — pins `data-turbo="false"` so the form is a plain
  `POST` rather than a Turbo submission.

The runtime owns serialization and transport; `render` returns Preact VNodes.

## Lifecycle hooks

Optional hooks are awaited in order:

- `hydrate(state, context)` — after a snapshot is verified and before any client
  edit, for server-side rehydration.
- `updating(state, context)` — before client edits; may throw a value-free error
  to reject the update.
- `updated(state, context)` — after a successful update or action, before the
  re-render.
- `mount(context)` — once, on the first live server render.

Hooks receive the mutable server-side state and may mutate it in place. `mount`
is the exception: it receives only the context.

## Computed properties

`computed` maps names to `(state, context)` functions that derive a read-only
view value at render time (a Promise result is awaited). Expose them to `render`
through `tools.computed(name)` — memoized per render. Computed values are never
persisted and never client-writable, and a name that collides with a top-level
state field is rejected at definition time.

## Signed, stateless snapshots

An update verifies the snapshot **before** the component is looked up: an
HMAC-SHA256 signature, an expiry, a hashed subject binding, and a trusted origin.
It then enforces same-origin plus a required CSRF header (the session CSRF
token, or for an anonymous public component the verified snapshot id — a
possession token, not an authentication identity), re-runs the component
`authorize` for the **current** request, applies client edits under
`writableKeys`, validates the strict state, runs at most one allowlisted action,
re-validates the whole state, and returns a re-signed snapshot plus synchronized
HTML. A `ZodError` thrown from `run` becomes a `422` with field errors and
repopulated values.

State is **PUBLIC**. The token is integrity-protected, **not encrypted**, and
readable by anyone who holds it — never place credentials or secrets in
component state. There is **no exactly-once processing, no replay prevention,
and no atomic DB rollback**: a valid token can be replayed until it expires and
every request reconstructs state from it, so a handler must make its own
persistence idempotent. This is not full Livewire parity.

## The update endpoint

The HTTP layer mounts `POST /_jsails/components/update`, but **only when an
extension registered a runtime**. The runtime owns every origin, CSRF,
signature, and policy check, so the endpoint is inert until the plugin is added.

## Static export with `staticFallback`

`staticFallback(context)` is the **only** thing rendered during static export:
read-only, with no signing key, no state, and no actions. A component without one
throws a value-free error in static mode. The static wrapper still carries the
component-name attributes but has **no** snapshot, CSRF token, or live id, and no
interactive form.

## Registering with `serverComponentsPlugin`

Register components through the `serverComponentsPlugin` extension. `components`
is a plain object map keyed by name — arrays are rejected.

```js
// jsails.app.js  (app-owned; compiled ESM)
import { serverComponentsPlugin } from 'jsails/server-components';
import { taskList } from './dist/components/task-list.js';

export default {
  rootDir: '.',
  extensions: [
    // The key is not hardcoded: explicit signingKey / JSAILS_COMPONENT_SECRET,
    // or an ephemeral key only in development/test, else a live render fails.
    serverComponentsPlugin({ components: { 'task-list': taskList } }),
  ],
};
```

Signing-key precedence is resolved **lazily**, only when a live render or update
signs or verifies: explicit `signingKey` → `JSAILS_COMPONENT_SECRET` → a fresh
random key **only** when `NODE_ENV` is exactly `development` or `test` →
otherwise a `ServerComponentError`. A standalone `jsails serve` outside those
modes must configure the key; the framework ships **no fake identity or auth
kit**. The starter's `task-list` is an explicitly public, **transient** demo
whose policy is `authorize: () => true`; replacing that with a real session check
is the app's job.

## Rendering from a page

Render a component from a page's `load` with `renderServerComponent(name,
context)` (a Preact VNode) or `renderServerComponentHtml(name, context)` (a raw
string).

```tsx
// pages/tasks.tsx  (app-owned page)
import type { RequestContext } from 'jsails';
import { renderServerComponent } from 'jsails/server-components';

export async function load(context: RequestContext) {
  return { taskList: await renderServerComponent('task-list', context) };
}
export default function Tasks({ taskList }: { taskList: unknown }) {
  return <main>{taskList}</main>;
}
```

## Nested components

`defineNestedComponent` / `renderNested` let a parent render independently
authorised, stateful children, each with its own signed snapshot, CSRF marker,
and component id. Child state is fully independent — every render and update goes
through the child's own `mount` → `sign` → `verify` lifecycle, with its own
`authorize` and `writableKeys`. `MAX_NESTING_DEPTH` (8) bounds the tree depth;
`NestedComponentError` is raised when a component is not found, the depth is
exceeded, or a child's own signature or security check fails.

## Form objects

`defineForm` wraps a Zod object schema and provides typed field access,
`fill` / `validate` / `reset` helpers, and `toState` / `fromState` JSON
round-trip methods compatible with the server-component snapshot protocol. A
`FormObject` is a plain object created inside a component action or lifecycle
hook; `FormDefinitionError` is raised for an invalid schema or options.

## Next steps

- [Client Runtime](/docs/client) — islands, Turbo navigation, and hydration in the browser.
