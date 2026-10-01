/**
 * Starter tasks page: a live server component beside a local island.
 *
 * `load` renders the `task-list` server component through the render helper and
 * passes the resulting VNode to the default page as a prop. The page itself is
 * a plain synchronous component: async work belongs in `load`, never in a
 * component body.
 *
 * The counter island is mounted OUTSIDE the server component root on purpose.
 * A server-component update morphs only its own root, so the island's local
 * Preact state (the count) must survive an `add` submission. Keeping the island
 * outside the component root is what proves that boundary.
 *
 * The island markers are the SSR/author contract:
 * - `data-jsails-island="counter"` — the registered component name
 * - `data-jsails-props='{"initial":0}'` — the serialized props
 *
 * The client entry registers the `counter` island and hydrates that exact
 * element; there is no manual `fetch` or `hydrate` call here.
 */

import type { VNode } from 'preact';

import type { RequestContext } from 'jsails';
import { renderServerComponent } from 'jsails/server-components';

import { Counter, INITIAL_COUNT } from '../ui/counter.js';
import { Layout, loadLayout, type LayoutAssets } from '../ui/layout.js';

export interface TasksPageProps {
  /** The rendered server component, produced in `load`. */
  taskList: VNode;
  /** Resolved asset URLs, produced in `load` and forwarded to the layout. */
  assets?: LayoutAssets;
  /** The current request path, used to mark the active nav link. */
  path?: string;
}

export async function load(context: RequestContext): Promise<TasksPageProps> {
  const [taskList, assets] = await Promise.all([
    renderServerComponent('task-list', context),
    loadLayout(context),
  ]);
  return { taskList, assets, path: context.url.pathname };
}

export default function TasksPage({ taskList, assets, path }: TasksPageProps) {
  return (
    <Layout title="Tasks — JSails Starter" assets={assets} path={path}>
      <header class="flex flex-col gap-3">
        <span class="text-xs font-medium uppercase tracking-wider text-base-content/50">
          Server component
        </span>
        <h1 class="text-4xl font-bold tracking-tight">Tasks</h1>
        <p class="max-w-2xl text-base-content/65">
          A server component with a backend action, next to a local island.
        </p>
      </header>

      <div class="mt-8 grid gap-6 lg:grid-cols-[1.1fr_1fr] lg:items-start">
        {taskList}

        <div
          id="counter-root"
          data-jsails-island="counter"
          data-jsails-props={JSON.stringify({ initial: INITIAL_COUNT })}
        >
          <Counter initial={INITIAL_COUNT} />
        </div>
      </div>

      <footer class="mt-10 text-center text-sm text-base-content/55">
        <p>
          Adding a task updates only the server component. The counter above is local to the page
          and keeps its value across an add.
        </p>
      </footer>
    </Layout>
  );
}
