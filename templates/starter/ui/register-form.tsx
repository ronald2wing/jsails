/**
 * Starter self-registration island.
 *
 * The `/api/register` route returns JSON (200 `{ status: 'ok' }` on success,
 * 422 `{ error }` on a duplicate/invalid submission) rather than a server
 * redirect, so this is the one auth step that needs client JavaScript: the
 * island posts the form via `fetch`, redirects to `/login` on success, and
 * renders a generic error otherwise. The password never persists outside the
 * in-flight fetch — there is no state, no localStorage, and no client SDK.
 *
 * The response never distinguishes a duplicate email from a provider failure
 * (by design), so the error text stays generic.
 */

import { useState } from 'preact/hooks';

import { Field } from './components.js';

/** The form state: idle, submitting, or a generic failure message. */
type RegisterStatus = { kind: 'idle' } | { kind: 'submitting' } | { kind: 'error' };

/**
 * A self-registration form. Posts `name`/`email`/`password` to `/api/register`
 * and navigates to `/login` on success. Server-rendered into the register page.
 */
export function RegisterForm() {
  const [status, setStatus] = useState<RegisterStatus>({ kind: 'idle' });

  async function onSubmit(event: Event) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);

    setStatus({ kind: 'submitting' });
    try {
      const response = await fetch('/api/register', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          name: String(data.get('name') ?? ''),
          email: String(data.get('email') ?? ''),
          password: String(data.get('password') ?? ''),
        }).toString(),
      });
      if (response.ok) {
        window.location.href = '/login?registered=1';
        return;
      }
      setStatus({ kind: 'error' });
    } catch {
      setStatus({ kind: 'error' });
    }
  }

  const submitting = status.kind === 'submitting';

  return (
    <form onSubmit={onSubmit} class="flex w-full flex-col gap-4">
      {status.kind === 'error' ? (
        <p class="alert alert-error text-sm" role="alert">
          Could not create the account. Try a different email address.
        </p>
      ) : null}
      <Field id="name" label="Name">
        <input
          id="name"
          type="text"
          name="name"
          class="input input-bordered w-full"
          autocomplete="name"
          required
          disabled={submitting}
        />
      </Field>
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
      <Field id="password" label="Password">
        <input
          id="password"
          type="password"
          name="password"
          class="input input-bordered w-full"
          autocomplete="new-password"
          required
          disabled={submitting}
        />
      </Field>
      <button type="submit" class="btn btn-primary mt-1 w-full" disabled={submitting}>
        {submitting ? 'Creating account…' : 'Create account'}
      </button>
    </form>
  );
}
