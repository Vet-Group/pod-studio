import type { Metadata } from 'next';
import Link from 'next/link';
import { findInvite } from '@pod-studio/core';
import { InviteAcceptForm } from '@/components/auth/invite-accept-form';
import { Button } from '@/components/ui/button';
import { getDatabase } from '@/lib/auth';

export const metadata: Metadata = { title: 'Accept invite', referrer: 'no-referrer' };

const UNUSABLE = {
  not_found: {
    title: 'This invite link does not work',
    body: 'Check that you copied the whole link, or ask the person who invited you for a new one.',
  },
  expired: {
    title: 'This invite link has expired',
    body: 'Invite links last 7 days. Ask the person who invited you for a new one.',
  },
  used: {
    title: 'This invite link was already used',
    body: 'Each link works once. If you accepted it yourself, sign in with the password you chose.',
  },
  revoked: {
    title: 'This invite link was withdrawn',
    body: 'The person who invited you cancelled it. Ask them for a new one if you still need access.',
  },
} as const;

export default async function InvitePage({ params }: PageProps<'/invite/[token]'>) {
  const { token } = await params;
  const invite = await findInvite(getDatabase(), token);

  if (invite.status !== 'valid') {
    const copy = UNUSABLE[invite.status];
    return (
      <>
        <header className="mb-7">
          <h1 className="text-[30px] leading-[1.2] font-semibold tracking-[-1px]">{copy.title}</h1>
          <p className="text-muted mt-2.5 text-[13px] text-pretty">{copy.body}</p>
        </header>
        <Button asChild variant="secondary" className="h-11 w-full">
          <Link href="/login">Go to sign in</Link>
        </Button>
      </>
    );
  }

  return (
    <>
      <header className="mb-7">
        <h1 className="text-[30px] leading-[1.2] font-semibold tracking-[-1px]">Join POD Studio</h1>
        <p className="text-muted mt-2.5 text-[13px] text-pretty">
          You were invited as <strong className="text-ink break-all">{invite.email}</strong>. Enter your name and choose a
          password to create your account.
        </p>
      </header>
      <InviteAcceptForm token={token} email={invite.email} expiresAt={invite.expiresAt.toISOString()} />
    </>
  );
}
