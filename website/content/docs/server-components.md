---
title: Server Components
order: 9
section: Building
---

# Server Components

JSails' server-component system takes a Livewire-like approach to interactive UI. `jsails/server-components` provides this surface for JSails pages.
A server component is **stateless on the server**: its state travels to the
client inside a signed snapshot and back on every update, so the server keeps no
session-side UI store. The subpath is **server-only** — it imports `node:crypto`
and Preact — and it is mounted through an extension plugin.

## Defining a component

Define a component with `defineServerComponent` and its actions with
`defineAction`. The registry key is the component `name`.

```tsx
// components/task-list.tsx  (app-owned; server-only module)
import { z } from 'zod'; // third-party packages stay explicit imports
// `defineAction` and `defineServerComponent` are installed as globals.

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

## The authoring surface: `defineComponent`

`defineServerComponent` is the lower-level primitive; most components are better
authored with `defineComponent`, the friendly surface that lowers onto it. It
takes the same options plus three authoring additions: `actions` split by
capability, `derived` view values, and a `style` contract.

```tsx
// components/task-list.tsx  (app-owned; server-only module)
import { z } from 'zod';

const stateSchema = z
  .object({ title: z.string().max(120), tasks: z.array(z.string().min(1)).max(50) })
  .strict();

const style = defineStyle({
  form: 'flex items-start gap-2',
  input: 'input input-bordered w-full',
  submit: 'btn btn-primary',
});

export const taskList = defineComponent<z.infer<typeof stateSchema>>({
  name: 'task-list',
  stateSchema,
  style,
  writableKeys: ['title'],
  initialState: () => ({ title: '', tasks: [] }),
  authorize: (context) => context.session !== null,
  actions: {
    add: serverAction({
      input: z.object({}),
      run(state) {
        const title = state.title.trim();
        if (title === '') throw new z.ZodError([]);
        state.tasks.push(title);
        state.title = '';
      },
    }),
  },
  derived: {
    count: (state) => state.tasks.length, // never persisted, never writable
  },
  render(state, { bind, submit, derived }) {
    const count = derived('count') as number;
    return (
      <form class={style.slot('form')} {...submit('add')}>
        <input class={style.slot('input')} {...bind('title')} />
        <button class={style.slot('submit')} type="submit">
          Add ({count})
        </button>
      </form>
    );
  },
  staticFallback: () => <p>The live task list is unavailable in the static export.</p>,
});
```

The three artifacts — **model** (`stateSchema` + `actions` + `derived`), **view**
(`render`), and **style** (`defineStyle`) — may live in one file or be split
across several; both are first-class. A **client-safe vs server-only** seam is
mandatory only when a component carries server-only code (see below).

When authoring a single-file component, use `// #region <name>` and
`// #endregion <name>` comments to mark the four logical sections: `model`,
`server`, `style`, and `view` (in that order). These are pure comments — they
make the sections foldable in an editor and document the split boundaries, but
they do not change component behavior. The `model` region covers the state
schema and type; `server` holds `'use server'` functions; `style` wraps the
`defineStyle` call; and `view` contains the `defineComponent` call and
remaining definitions.

### `localAction` vs `serverAction` — the capability split

An action is one of two kinds, and the choice is enforced by the type system:

- `serverAction({ input?, authorize?, run(state, args, context) })` — round-trips
  through the signed snapshot, with authorize, CSRF, and schema validation. Its
  `run` may perform I/O and change any schema-valid field.
- `localAction({ input?, run(state, args) })` — **pure and client-runnable**: it
  receives no `context`, returns synchronously, and cannot itself perform a
  persisted write. Use it for immediate, client-only reactions.

Because `localAction` has no `context` and no async body, a persisted write is
unreachable from one — the boundary is expressed in the signature, not in a
convention. `defineComponent` lowers both kinds onto the runtime's action shape,
tagged with `kind: 'local' | 'server'`.

### `derived` view values

`derived` maps names to `(state, context)` functions that recompute a read-only
view value at render time. Expose them through `tools.derived(name)`; they are
never persisted and never client-writable. `derived` is the authoring alias for
the runtime's `computed` (the name avoids a collision with `@preact/signals`'
own `computed`).

### `defineStyle` — a named-slot style contract

Class strings belong in a style contract, not inline in the view. `defineStyle`
takes a flat map of slot name to class string and returns a frozen contract;
`render` dereferences `style.slot(name)` instead of threading raw class lists.
A name that is not a declared slot is rejected — the guard checks the
view↔style boundary, not the class strings themselves.

### Client-safe vs server-only

A component with no server actions is client-safe and may live in a single file.
When a component carries server-only code, you have two seams:

- **Split the file.** Put the server-only half in `task-list.server.ts` and
  import it behind the seam. The framework's `cleanBundlePlugin` asserts at
  build time that no such module reaches the client bundle, naming the import
  chain when it does. This is the strongest guarantee: the module is refused
  outright.
- **Co-locate behind a function directive.** Mark a function with a leading
  `'use server'` string literal and the `serverDirectivePlugin` build transform
  replaces its body with a throwing stub wherever the module is bundled into a
  client chunk. The function's name, parameters, return type, and export stay
  intact, so existing imports still typecheck and resolve — but the body that
  may touch the database, session, or a server-only import never reaches the
  browser. A file-level `'use server'` directive marks every exported function
  in the module. The starter's `ui/task-notes.ts` demonstrates the pattern: a
  client-safe `summarizeNote` and a `'use server'` `persistNote` in one file.

Both plugins ship from `jsails/build` and are wired into the starter's
`vite.config.js`; add them to your own Vite/Rolldown config if you use a
different build. The transform is **fail-closed**: a `'use server'` directive in
a position it cannot rewrite (an object property, a class method, a re-export)
fails the build rather than silently shipping server code.

**What the directive does and does not do.** It lets server-only code live in a
single file and strips it from the client chunk — nothing more. It adds **no**
new way to submit an action and **no** new network surface: a client still
mutates state only through the signed-snapshot update endpoint
(`submit(action)`), and the throwing stub exists so a module is safe to _import_,
never so the function is _callable_. The browser never calls an action's `run`.

## `writableKeys` — what the client may edit

`writableKeys` names **only** the top-level fields a client update may set
(default: none; every entry must be a real top-level field). This restricts
_client_ edits only: actions run server-side and may change **any** schema-valid
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
state field is rejected at definition time. `defineComponent` authors the same
thing under the `derived` key with `tools.derived(name)` (see above).

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

Component state is public. The token is integrity-protected but not encrypted, so anyone who holds it can read it. Never place credentials or secrets in component state. There is **no exactly-once processing, no replay prevention,
and no atomic DB rollback**: a valid token can be replayed until it expires and
every request reconstructs state from it, so a handler must make its own
persistence idempotent. This is a deliberately reduced feature set compared to a full Livewire-style library.

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

- [Client & Islands](/docs/client) — islands, Turbo navigation, and hydration in the browser.
- [Routing](/docs/routing) — pages, API routes, and layouts.
