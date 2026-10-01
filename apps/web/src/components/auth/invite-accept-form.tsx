'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormAlert } from '@/components/auth/field';
import { authRequest, navigate } from '@/lib/auth-client';
import { useHydrated } from '@/lib/use-hydrated';

const PASSWORD_HINT = '10 to 128 characters. A short sentence is easier to remember than symbols.';

export function InviteAcceptForm({ token, email, expiresAt }: { token: string; email: string; expiresAt: string }) {
  const hydrated = useHydrated();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    if (password !== String(form.get('confirm') ?? '')) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    setPending(true);
    setError(null);
    const result = await authRequest('/invite/accept', { token, name: String(form.get('name') ?? ''), password });
    if (!result.ok) {
      setError(result.error.message);
      setPending(false);
      return;
    }
    navigate('/');
  }

  return (
    <form method="post" onSubmit={onSubmit} className="grid gap-5">
      <FormAlert message={error} />
      <Field label="Email" name="email" type="email" value={email} readOnly autoComplete="username" />
      <Field label="Your name" name="name" autoComplete="name" required maxLength={100} autoFocus />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        minLength={10}
        maxLength={128}
        hint={PASSWORD_HINT}
      />
      <Field
        label="Confirm password"
        name="confirm"
        type="password"
        autoComplete="new-password"
        required
        error={mismatch ? 'The two passwords do not match.' : undefined}
      />
      <Button type="submit" variant="primary" className="mt-1 h-11 w-full text-[14px]" disabled={!hydrated || pending}>
        {pending ? 'Creating account…' : 'Create account'}
      </Button>
      <p className="text-muted text-[12.5px] leading-[1.6]">
        This link works once and expires on{' '}
        <time dateTime={expiresAt}>
          {new Date(expiresAt).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}
        </time>
        .
      </p>
    </form>
  );
}
