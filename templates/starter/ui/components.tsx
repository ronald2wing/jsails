/**
 * JSails starter UI: two thin wrappers over native HTML, styled with daisyUI.
 *
 * Design constraints:
 * - Browser-safe: imports only from `preact` and `preact/hooks`, never the
 *   root `jsails` entry (which pulls in TypeORM/reflect-metadata).
 * - No CSS import here. Styling lives in `templates/starter/ui/styles.css`
 *   (Tailwind 4 + daisyUI 5) and ships as a raw starter asset. Importing CSS
 *   from this module would break Node SSR.
 * - Native HTML semantics over reimplemented ARIA: `<dialog>` for modals. No
 *   focus-trap or keyboard manager is invented; the browser owns that behavior.
 * - Only two wrappers exist, and only because they add real behavior:
 *   `Field` links a label/help/error to a control by id, and `Dialog` drives a
 *   native `<dialog>` from a controlled `open` prop. Buttons, cards, alerts,
 *   and disclosures are plain TSX with daisyUI classes — wrapping every class
 *   name would add indirection without adding behavior.
 * - SSR/hydration parity: no random or hook-generated ids. Callers pass
 *   explicit `id`s (or wrap the control in a `<label>`), so server markup and
 *   client hydration agree and ids never collide across islands.
 */

import { useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren, DialogHTMLAttributes, HTMLAttributes } from 'preact';

/** Merge a caller class with a component class, dropping empties. */
function cx(...parts: unknown[]): string {
  return parts
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');
}

/* -------------------------------------------------------------------------- */
/* Field                                                                      */
/* -------------------------------------------------------------------------- */

export interface FieldProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Explicit id of the control this field labels. Required for the
   * `<label for>` linkage; without it the label is not associated.
   */
  id?: string;
  /** Visible label text. */
  label: ComponentChildren;
  /** Optional helper text, linked via `aria-describedby`. */
  help?: ComponentChildren;
  /** Optional error text; adds invalid styling and a `role="alert"` message. */
  error?: ComponentChildren;
  /** The control to render. */
  children: ComponentChildren;
}

/**
 * A labelled form control with optional help and error text.
 *
 * Accessibility linkage is explicit and id-based: `label` gets `for={id}`,
 * help/error get derived ids (`${id}-help`, `${id}-error`). The caller must
 * pass the same `id` to the control and reference those ids from its
 * `aria-describedby` (e.g. `<input id="email" aria-describedby="email-help" />`).
 * When no `id` is given, the label is rendered without `for` and no derived ids
 * are emitted — the caller can instead wrap the control in the label.
 */
export function Field({ id, label, help, error, children, class: className, ...rest }: FieldProps) {
  const helpId = id ? `${id}-help` : undefined;
  const errorId = id ? `${id}-error` : undefined;

  return (
    <div {...rest} class={cx('fieldset', className)}>
      <label class="label" for={id}>
        {label}
      </label>
      {children}
      {help ? (
        <p class="label" id={helpId}>
          {help}
        </p>
      ) : null}
      {error ? (
        <p class="label text-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Dialog                                                                     */
/* -------------------------------------------------------------------------- */

export interface DialogProps extends Omit<
  DialogHTMLAttributes<HTMLDialogElement>,
  'open' | 'onClose' | 'onCancel'
> {
  /** Controlled open state. The component syncs the native dialog to it. */
  open: boolean;
  /**
   * Accessible name. Required: rendered as `aria-label` unless `aria-labelledby`
   * is supplied instead.
   */
  label?: string;
  /** Called when the dialog closes (Esc, backdrop, or `close()`). */
  onClose?: () => void;
  /** Called when the user requests cancel (Esc). Return value is ignored. */
  onCancel?: () => void;
  children?: ComponentChildren;
}

/**
 * A native `<dialog>` driven by a controlled `open` prop.
 *
 * The component calls `showModal()`/`close()` in an effect to match `open`.
 * The browser owns focus management, Esc handling, and the top layer; no
 * focus trap is reimplemented. `onClose`/`onCancel` are wired to the native
 * events. During SSR the dialog renders without `open` (effects do not run),
 * so the initial client markup matches and hydration is clean.
 *
 * An accessible name is required: pass `label` (or `aria-labelledby`).
 */
export function Dialog({
  open,
  label,
  onClose,
  onCancel,
  class: className,
  children,
  ...rest
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    else if (!open && node.open) node.close();
  }, [open]);

  return (
    <dialog
      {...rest}
      ref={ref}
      aria-label={label}
      class={cx('modal', className)}
      onClose={onClose}
      onCancel={onCancel}
    >
      {children}
    </dialog>
  );
}
