/**
 * Starter password-reset island.
 *
 * The `/api/password-reset` route answers JSON (`{ status: 'ok' }` regardless of
 * whether the email exists, by design — it never leaks account existence), so
 * this island posts the email and then shows the standard "if that address
 * exists, a reset link was sent" message. The `/api/password-reset/confirm`
 * step is a link-click flow that lands on its own page; this island covers the
 * initial request only.
 */

import { useState } from 'preact/hooks';

import { Field } from './components.js';

type ResetStatus = { kind: 'idle' } | { kind: 'submitting' } | { kind: 'sent' } | { kind: 'error' };

/** The forgot-password request form. */
export function ResetForm() {
  const [status, setStatus] = useState<ResetStatus>({ kind: 'idle' });

  async function onSubmit(event: Event) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);

    setStatus({ kind: 'submitting' });
    try {
      const response = await fetch('/api/password-reset', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: String(data.get('email') ?? '') }).toString(),
      });
      if (response.ok) {
        setStatus({ kind: 'sent' });
        return;
      }
      setStatus({ kind: 'error' });
    } catch {
      setStatus({ kind: 'error' });
    }
  }

  if (status.kind === 'sent') {
    return (
      <p class="alert alert-success text-sm" role="status">
        If that address has an account, a password-reset link was sent.
      </p>
    );
  }

  const submitting = status.kind === 'submitting';

  return (
    <form onSubmit={onSubmit} class="flex w-full flex-col gap-4">
      {status.kind === 'error' ? (
        <p class="alert alert-error text-sm" role="alert">
          Could not send the reset email. Try again.
        </p>
      ) : null}
      <Field id="email" label="Email">
        <input
          id="email"
          type="email"
          name="email"
          class="input input-bordered w-full"
          autocomplete="email"
          required
          disabled={submitting}
        />
      </Field>
      <button type="submit" class="btn btn-primary mt-1 w-full" disabled={submitting}>
        {submitting ? 'Sending…' : 'Send reset link'}
      </button>
    </form>
  );
}
