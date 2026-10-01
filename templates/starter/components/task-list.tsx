/**
 * Starter task list: a stateful server component with one backend action.
 *
 * This is the "real backend" demo, deliberately separate from the local
 * counter island. It is authored with the friendly `defineComponent` surface
 * (see `jsails/server-components`): state lives on the server and is carried in
 * a signed snapshot, and the `add` action runs server-side and re-renders the
 * list. There is no database and no identity: the component is a public demo,
 * so its policy is an explicit `authorize: () => true` (see below) and its state
 * is transient per-component data, not a user record.
 *
 * Authoring contract:
 * - `stateSchema` is the single source of truth for persisted state and is
 *   forced `.strict()`, so no undeclared field survives a round-trip.
 * - `writableKeys` names the fields a CLIENT edit may set. Only `title` is
 *   writable; `tasks` is server-owned and can only change through an action.
 * - `actions.add` is a `serverAction`: its `run` executes server-side only and
 *   round-trips through the signed snapshot (with authorize + CSRF + schema
 *   validation). A `localAction` would be pure and client-runnable; a persisted
 *   write is deliberately unreachable from one.
 * - Action args are a separate object from state, never an assumed `FormData`
 *   mapping. `add` declares an explicit empty args schema (`z.object({})`) and
 *   reads the title from `state.title`, which the bound input writes.
 * - `derived.count` is a read-only view value recomputed at render time; it is
 *   never persisted and never client-writable.
 * - Class strings live in a named-slot `style` contract; `render` dereferences
 *   `style.slot(name)` instead of threading raw class lists.
 * - `render` receives `bind`/`submit` helpers that return attribute maps to
 *   spread onto elements; the runtime owns the transport.
 *
 * Stable `data-*` markers are the browser-verification contract:
 * - `data-task-input`  — the title input
 * - `data-task-submit` — the add button
 * - `data-task-item`   — each rendered task
 * - `data-task-error`  — the validation error message
 */

import { z } from 'zod';

import { defineComponent, defineStyle, serverAction } from '../app/application-component.js';

// #region model

/** Maximum title length accepted by the state schema. */
const MAX_TITLE_LENGTH = 120;

/** Maximum number of tasks kept in the demo list. */
const MAX_TASKS = 50;

/**
 * The persisted state shape. `title` permits a blank initial value (the input
 * starts empty); the `add` action enforces a non-blank trimmed title. `tasks`
 * is bounded so a client cannot grow the snapshot without limit.
 */
const stateSchema = z
  .object({
    title: z.string().max(MAX_TITLE_LENGTH),
    tasks: z.array(z.string().min(1).max(MAX_TITLE_LENGTH)).max(MAX_TASKS),
  })
  .strict();

type TaskListState = z.infer<typeof stateSchema>;

/** The trimmed, non-blank title an `add` submission must carry. */
const titleSchema = z.object({
  title: z.string().trim().min(1),
});

// #endregion model

// #region server

// Server-only functions go here (add 'use server' functions when the
// component needs database access or other server-only logic).

// #endregion server

// #region style

/**
 * The component's class strings, one per named slot. Keeping them in a style
 * contract separates presentation tokens from the view structure: `render`
 * asks for a slot, never a raw Tailwind literal.
 */
const style = defineStyle({
  card: 'card w-full bg-base-100 shadow-xl',
  body: 'card-body',
  title: 'card-title',
  intro: 'text-base-content/70',
  form: 'flex w-full items-start gap-2',
  input: 'input input-bordered w-full',
  submit: 'btn btn-primary',
  error: 'text-error',
  empty: 'text-base-content/60',
  list: 'list w-full',
  item: 'list-row',
  count: 'text-sm text-base-content/60',
});

// #endregion style

// #region view

export const taskList = defineComponent<TaskListState>({
  name: 'task-list',
  stateSchema,
  style,
  // Only the title input is client-writable; the task list is server-owned.
  writableKeys: ['title'],
  initialState() {
    return { title: '', tasks: [] };
  },
  // Public demo policy: this starter has no identity system, so the component
  // is intentionally open. A real app replaces this with its own session check
  // (the runtime is default-deny and requires an exact `true`).
  authorize() {
    return true;
  },
  actions: {
    add: serverAction({
      // Explicit empty args: the title is read from bound state, never derived
      // from an assumed FormData shape.
      input: z.object({}),
      run(state) {
        const parsed = titleSchema.safeParse({ title: state.title });
        if (!parsed.success) {
          // Reject a blank/whitespace title. The runtime maps a ZodError thrown
          // from `run` to a 422 field error and re-renders with `errors.title`.
          throw parsed.error;
        }
        state.tasks.push(parsed.data.title);
        state.title = '';
      },
    }),
  },
  derived: {
    count: (state) => state.tasks.length,
  },
  render(state, { bind, submit, errors, derived }) {
    const titleError = errors.title;
    const count = derived('count') as number;
    return (
      <section class={style.slot('card')}>
        <div class={style.slot('body')}>
          <h2 class={style.slot('title')}>Task list</h2>
          <p class={style.slot('intro')}>
            Tasks are stored on the server for this component instance. There is no database and no
            account — reloading starts a fresh list.
          </p>

          <form class={style.slot('form')} {...submit('add')}>
            <input
              type="text"
              class={style.slot('input')}
              placeholder="Add a task"
              maxLength={MAX_TITLE_LENGTH}
              aria-label="Task title"
              aria-invalid={titleError ? true : undefined}
              data-task-input
              {...bind('title')}
            />
            <button type="submit" class={style.slot('submit')} data-task-submit>
              Add
            </button>
          </form>

          {titleError ? (
            <p class={style.slot('error')} role="alert" data-task-error>
              {titleError}
            </p>
          ) : null}

          {count === 0 ? (
            <p class={style.slot('empty')}>No tasks yet.</p>
          ) : (
            <>
              <p class={style.slot('count')}>{count} task(s)</p>
              <ul class={style.slot('list')}>
                {state.tasks.map((task, index) => (
                  <li class={style.slot('item')} data-task-item key={`${index}-${task}`}>
                    {task}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </section>
    );
  },
  staticFallback() {
    // Static export has no request context, so no state, signing, or actions.
    // Render a clear, read-only notice instead of a dead form.
    return (
      <section class={style.slot('card')}>
        <div class={style.slot('body')}>
          <h2 class={style.slot('title')}>Task list</h2>
          <p class={style.slot('intro')}>
            The task list is a live server component. It is not available in the static export — run
            the app with <code>jsails serve</code> to use it.
          </p>
        </div>
      </section>
    );
  },
});

// #endregion view
