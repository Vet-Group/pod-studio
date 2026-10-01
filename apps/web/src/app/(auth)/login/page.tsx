import type { Metadata } from 'next';
import { safeNextPath } from '@pod-studio/core';
import { LoginForm } from '@/components/auth/login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const { next } = await searchParams;
  return (
    <>
      <header className="mb-7">
        <h1 className="text-[30px] leading-[1.2] font-semibold tracking-[-1px]">Sign in</h1>
        <p className="text-muted mt-2.5 text-[13px] text-pretty">
          Accounts are created by an admin or through an invite link. There is no public sign-up.
        </p>
      </header>
      <LoginForm next={safeNextPath(Array.isArray(next) ? next[0] : next)} />
    </>
  );
}
