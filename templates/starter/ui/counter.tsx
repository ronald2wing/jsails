/**
 * Starter counter island.
 *
 * A self-contained, frontend-only demo: the count lives in a Preact signal and
 * the dialog is driven by local component state. Nothing here talks to a
 * backend, dispatches an action, or persists anything — reloading the page
 * resets the count to `INITIAL_COUNT`.
 *
 * SSR/hydration parity: the initial count comes from the `initial` prop (never
 * a random value or a hook-generated id), and the dialog renders closed during
 * SSR because effects do not run on the server. The client entry hydrates the
 * exact `#counter-root` element with the same `INITIAL_COUNT`, so the first
 * client render matches the server markup.
 *
 * Stable `data-*` markers are the browser-verification contract:
 * - `data-counter-value`     — the current count
 * - `data-counter-increment` — the increment button
 * - `data-open-dialog`       — the button that opens the demo dialog
 * - `data-close-dialog`      — the button that closes the demo dialog
 */

import { useSignal } from '@preact/signals';
import { useState } from 'preact/hooks';

import { Dialog } from './components.js';

/** The count a freshly loaded page starts from. */
export const INITIAL_COUNT = 0;

export interface CounterProps {
  /** Starting count. Must be deterministic so SSR and hydration agree. */
  initial: number;
}

/**
 * A local counter with a native-dialog demo.
 *
 * The dialog is controlled by local state and closed on Esc (native `cancel`)
 * or the close button. Its accessible name is always present: the visible
 * heading is referenced with `aria-labelledby`, so the dialog is never
 * unlabelled even though no `label` string is passed.
 */
export function Counter({ initial }: CounterProps) {
  const count = useSignal(initial);
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div class="card bg-base-100 shadow-xl">
      <div class="card-body items-center text-center">
        <h2 class="card-title">Counter</h2>
        <p class="text-base-content/70">
          This count is local to the page. Reloading resets it to {INITIAL_COUNT}.
        </p>
        <p class="text-5xl font-bold" data-counter-value>
          {count.value}
        </p>
        <div class="card-actions">
          <button
            type="button"
            class="btn btn-primary"
            data-counter-increment
            onClick={() => {
              count.value += 1;
            }}
          >
            Increment
          </button>
          <button
            type="button"
            class="btn btn-outline"
            data-open-dialog
            onClick={() => {
              setDialogOpen(true);
            }}
          >
            Open dialog
          </button>
        </div>
      </div>

      <Dialog
        open={dialogOpen}
        aria-labelledby="counter-dialog-title"
        onClose={() => {
          setDialogOpen(false);
        }}
        onCancel={() => {
          setDialogOpen(false);
        }}
      >
        <div class="modal-box">
          <h3 class="text-lg font-bold" id="counter-dialog-title">
            Local demo dialog
          </h3>
          <p class="py-4">
            This dialog is frontend-only state. It sends nothing to a server and closes on Esc or
            the button below.
          </p>
          <div class="modal-action">
            <button
              type="button"
              class="btn"
              data-close-dialog
              onClick={() => {
                setDialogOpen(false);
              }}
            >
              Close
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
