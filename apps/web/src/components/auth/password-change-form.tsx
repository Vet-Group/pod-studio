'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormAlert } from '@/components/auth/field';
import { authRequest, navigate } from '@/lib/auth-client';
import { useHydrated } from '@/lib/use-hydrated';

export function PasswordChangeForm({ email, forced }: { email: string; forced: boolean }) {
  const hydrated = useHydrated();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get('newPassword') ?? '');
    if (newPassword !== String(form.get('confirm') ?? '')) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    setPending(true);
    setError(null);
    const result = await authRequest('/password/change', {
      currentPassword: String(form.get('currentPassword') ?? ''),
      newPassword,
    });
    if (!result.ok) {
      setError(result.error.message);
      setPending(false);
      return;
    }
    navigate('/');
  }

  async function signOut() {
    await authRequest('/sign-out', {});
    navigate('/login');
  }

  return (
    <form method="post" onSubmit={onSubmit} className="grid gap-5">
      <FormAlert message={error} />
      {/* Lets password managers file the new password under the right account. */}
      <input type="email" name="username" value={email} autoComplete="username" readOnly hidden />
      <Field
        label={forced ? 'Temporary password' : 'Current password'}
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        required
        autoFocus
      />
      <Field
        label="New password"
        name="newPassword"
        type="password"
        autoComplete="new-password"
        required
        minLength={10}
        maxLength={128}
        hint={`10 to 128 characters, different from your ${forced ? 'temporary' : 'current'} password.`}
      />
      <Field
        label="Confirm new password"
        name="confirm"
        type="password"
        autoComplete="new-password"
        required
        error={mismatch ? 'The two passwords do not match.' : undefined}
      />
      <Button type="submit" variant="primary" className="mt-1 h-11 w-full text-[14px]" disabled={!hydrated || pending}>
        {pending ? 'Saving…' : forced ? 'Save and continue' : 'Change password'}
      </Button>
      <p className="text-muted text-[12.5px]">
        Signed in as <strong className="text-ink break-all">{email}</strong>. Not you?{' '}
        <button type="button" onClick={signOut} disabled={!hydrated} className="text-teal min-h-11 font-semibold underline underline-offset-2">
          Sign out
        </button>
      </p>
    </form>
  );
}
