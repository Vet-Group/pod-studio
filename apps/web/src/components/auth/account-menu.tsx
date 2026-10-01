'use client';

import { useState } from 'react';
import { authRequest, navigate } from '@/lib/auth-client';
import { useHydrated } from '@/lib/use-hydrated';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase() || '?';
}

/** Current account at the foot of the sidebar, like `.sidebottom` in the wireframe, with sign-out. */
export function AccountMenu({ name, email, role }: { name: string; email: string; role: string }) {
  const hydrated = useHydrated();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    const result = await authRequest('/sign-out', {});
    if (!result.ok) {
      setPending(false);
      return;
    }
    navigate('/login');
  }

  return (
    <div className="border-line mt-auto border-t px-2.5 pt-5 max-md:mt-0 max-md:flex max-md:items-center max-md:justify-between max-md:gap-3 max-md:border-t-0 max-md:px-0 max-md:pt-0 max-md:pb-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden="true"
          className="grid size-8 shrink-0 place-items-center rounded-full bg-[#dcc8b6] text-[12.5px] font-bold text-[#5a4a3a]"
        >
          {initials(name)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[12px] font-bold" title={email}>
            {name}
          </p>
          <p className="text-muted text-[11.5px]">{role}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 text-[12px] max-md:mt-0">
        <a href="/change-password" data-tap className="text-teal inline-flex min-h-8 items-center font-semibold hover:underline">
          Change password
        </a>
        <button
          type="button"
          onClick={signOut}
          disabled={!hydrated || pending}
          className="text-ink inline-flex min-h-8 items-center font-semibold hover:underline disabled:opacity-50"
        >
          {pending ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </div>
  );
}
