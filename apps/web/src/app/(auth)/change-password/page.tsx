import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PasswordChangeForm } from '@/components/auth/password-change-form';
import { getCurrentSession } from '@/lib/session';

export const metadata: Metadata = { title: 'Change password' };

export default async function ChangePasswordPage() {
  const session = await getCurrentSession();
  if (!session) redirect('/login?next=%2Fchange-password');
  const forced = !!session.user.mustChangePassword;

  return (
    <>
      <header className="mb-7">
        <h1 className="text-[30px] leading-[1.2] font-semibold tracking-[-1px] text-balance">
          {forced ? 'Choose your password' : 'Change password'}
        </h1>
        <p className="text-muted mt-2.5 text-[13px] text-pretty">
          {forced
            ? 'You signed in with a temporary password from an admin. Choose your own before you continue.'
            : 'Your other devices are signed out after the change.'}
        </p>
      </header>
      <PasswordChangeForm email={session.user.email} forced={forced} />
    </>
  );
}
