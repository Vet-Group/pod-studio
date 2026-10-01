'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FormAlert } from '@/components/auth/field';
import { authRequest, navigate } from '@/lib/auth-client';
import { useHydrated } from '@/lib/use-hydrated';

export function LoginForm({ next }: { next: string }) {
  const hydrated = useHydrated();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const result = await authRequest<{ user?: { mustChangePassword?: boolean } }>('/sign-in/email', {
      email: String(form.get('email') ?? '').trim(),
      password: String(form.get('password') ?? ''),
    });
    if (!result.ok) {
      setError(result.error.message);
      setPending(false);
      return;
    }
    // The proxy would send a temporary password there anyway; going straight saves a redirect.
    navigate(result.data.user?.mustChangePassword ? '/change-password' : next);
  }

  return (
    <form method="post" onSubmit={onSubmit} className="grid gap-5">
      <FormAlert message={error} />
      <Field label="Email" name="email" type="email" autoComplete="username" required autoFocus />
      <Field label="Password" name="password" type="password" autoComplete="current-password" required />
      <Button type="submit" variant="primary" className="mt-1 h-11 w-full text-[14px]" disabled={!hydrated || pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
      <p className="text-muted text-[12.5px] leading-[1.6] text-pretty">
        Forgot your password? Ask an admin to reset it. Reset links are shared through chat, not email.
      </p>
    </form>
  );
}
