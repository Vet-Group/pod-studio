import type { Metadata } from 'next';
import { listAccounts, listStores } from '@pod-studio/core';
import { PageHead } from '@/components/page-head';
import { getDatabase } from '@/lib/auth';
import { principalOf } from '@/lib/principal';
import { requireAppSession } from '@/lib/session';
import { CreateStoreDialog } from '@/features/stores/create-store-dialog';
import { StoreCards } from '@/features/stores/store-cards';

export const metadata: Metadata = { title: 'Stores & members' };

/** Stores the signed-in user can see (all of them for an admin). Pick one to manage its members. */
export default async function StoresPage() {
  const session = await requireAppSession('/stores');
  const principal = principalOf(session.user);
  const db = getDatabase();
  const stores = await listStores(db, principal);
  const accounts = principal.role === 'admin' ? await listAccounts(db, principal) : [];

  return (
    <section aria-labelledby="screen-title">
      <PageHead
        eyebrow="Stores & members"
        title="Manage stores and permissions."
        actions={principal.role === 'admin' && accounts.length > 0 ? <CreateStoreDialog accounts={accounts} /> : null}
      >
        Each store has one owner. A person can own multiple stores. Pick a store to see its members.
      </PageHead>
      {stores.length > 0 ? (
        <StoreCards stores={stores} />
      ) : (
        <div className="bg-soft text-teal rounded-lg px-4 py-3 text-[13px]">
          <p>
            {principal.role === 'admin'
              ? 'No stores yet. Create the first store and choose its owner.'
              : 'You are not a member of any store yet. Ask a store owner or an admin to invite you.'}
          </p>
        </div>
      )}
    </section>
  );
}
