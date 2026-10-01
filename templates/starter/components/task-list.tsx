/**
 * Starter task list: a stateful server component with one backend action.
 *
 * This is the "real backend" demo, deliberately separate from the local
 * counter island. State lives on the server and is carried in a signed
 * snapshot; the `add` action runs server-side and re-renders the list. There is
 * no database and no identity: the component is a public demo, so its policy is
 * an explicit `authorize: () => true` (see below) and its state is transient
 * per-component data, not a user record.
 *
 * Authoring contract (see `jsails/server-components`):
 * - `stateSchema` is the single source of truth for persisted state and is
 *   forced `.strict()`, so no undeclared field survives a round-trip.
 * - `writableKeys` names the fields a CLIENT edit may set. Only `title` is
 *   writable; `tasks` is server-owned and can only change through an action.
 * - Action args are a separate object from state, never an assumed `FormData`
 *   mapping. `add` declares an explicit empty args schema (`z.object({})`) and
 *   reads the title from `state.title`, which the bound input writes.
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

import { defineAction, defineServerComponent } from 'jsails/server-components';

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

export const taskList = defineServerComponent<TaskListState>({
  name: 'task-list',
  stateSchema,
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
    add: defineAction({
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
  render(state, { bind, submit, errors }) {
    const titleError = errors.title;
    return (
      <section class="card w-full bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title">Task list</h2>
          <p class="text-base-content/70">
            Tasks are stored on the server for this component instance. There is no database and no
            account — reloading starts a fresh list.
          </p>

          <form class="flex w-full items-start gap-2" {...submit('add')}>
            <input
              type="text"
              class="input input-bordered w-full"
              placeholder="Add a task"
              maxLength={MAX_TITLE_LENGTH}
              aria-label="Task title"
              aria-invalid={titleError ? true : undefined}
              data-task-input
              {...bind('title')}
            />
            <button type="submit" class="btn btn-primary" data-task-submit>
              Add
            </button>
          </form>

          {titleError ? (
            <p class="text-error" role="alert" data-task-error>
              {titleError}
            </p>
          ) : null}

          {state.tasks.length === 0 ? (
            <p class="text-base-content/60">No tasks yet.</p>
          ) : (
            <ul class="list w-full">
              {state.tasks.map((task, index) => (
                <li class="list-row" data-task-item key={`${index}-${task}`}>
                  {task}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    );
  },
  staticFallback() {
    // Static export has no request context, so no state, signing, or actions.
    // Render a clear, read-only notice instead of a dead form.
    return (
      <section class="card w-full bg-base-100 shadow-xl">
        <div class="card-body">
          <h2 class="card-title">Task list</h2>
          <p class="text-base-content/70">
            The task list is a live server component. It is not available in the static export — run
            the app with <code>jsails serve</code> to use it.
          </p>
        </div>
      </section>
    );
  },
});
