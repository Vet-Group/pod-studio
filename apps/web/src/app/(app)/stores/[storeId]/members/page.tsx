import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  ROLE_PRESETS,
  STORE_PERMISSIONS,
  STORE_PERMISSION_LABELS,
  STORE_ROLE_LABELS,
  isAuthError,
  listMembers,
  listStoreInvites,
  listStores,
  type StoreMembers,
} from '@pod-studio/core';
import { PageHead } from '@/components/page-head';
import { getDatabase } from '@/lib/auth';
import { principalOf } from '@/lib/principal';
import { requireAppSession } from '@/lib/session';
import { InviteDialog } from '@/features/stores/invite-dialog';
import { MemberTable, type MemberView } from '@/features/stores/member-table';
import { PendingInvites } from '@/features/stores/pending-invites';
import { StoreCards } from '@/features/stores/store-cards';
import type { InviteView, PermissionOption, RoleOption } from '@/features/stores/types';

export const metadata: Metadata = { title: 'Stores & members' };

const permissionOptions: PermissionOption[] = STORE_PERMISSIONS.map((value) => ({ value, label: STORE_PERMISSION_LABELS[value] }));

function viewingAs(viewer: StoreMembers['viewer']): string {
  if (viewer.role === 'owner') return 'Viewing as store owner.';
  if (viewer.role) return `Viewing as ${STORE_ROLE_LABELS[viewer.role].toLowerCase()}${viewer.canManage ? '' : ' (read-only)'}.`;
  return 'Viewing as admin. Admins manage members but never publish without a grant.';
}

/** One store's members, roles and permissions, with invites for those who may manage members. */
export default async function StoreMembersPage({ params }: PageProps<'/stores/[storeId]/members'>) {
  const { storeId } = await params;
  const session = await requireAppSession(`/stores/${storeId}/members`);
  const principal = principalOf(session.user);
  const db = getDatabase();

  let data: StoreMembers;
  try {
    data = await listMembers(db, principal, storeId);
  } catch (error) {
    // NOT_FOUND covers both "no such store" and "not yours", so ids cannot be probed.
    if (isAuthError(error)) notFound();
    throw error;
  }
  const { store, members, viewer } = data;
  const [stores, invites] = await Promise.all([
    listStores(db, principal),
    viewer.canManage ? listStoreInvites({ db }, principal, storeId) : Promise.resolve([]),
  ]);

  const roles: RoleOption[] = viewer.inviteRoles.map((value) => ({
    value,
    label: STORE_ROLE_LABELS[value],
    permissions: [...ROLE_PRESETS[value]],
  }));
  const rows: MemberView[] = members.map((m) => ({
    ...m,
    roleLabel: STORE_ROLE_LABELS[m.role],
    isSelf: m.userId === principal.userId,
  }));
  const pending: InviteView[] = invites.map((i) => ({
    id: i.id,
    email: i.email,
    roleLabel: i.role ? STORE_ROLE_LABELS[i.role] : 'No store role',
    expires: i.expiresAt.toISOString().slice(0, 10),
  }));

  return (
    <section aria-labelledby="screen-title">
      <PageHead
        eyebrow="Stores & members"
        title="Manage stores and permissions."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild className="min-h-11">
              <Link href={`/stores/${store.id}/catalog`}>Catalog</Link>
            </Button>
            {viewer.role && (
              <Button asChild className="min-h-11">
                <Link href={`/stores/${store.id}/settings`}>Store settings</Link>
              </Button>
            )}
            <InviteDialog
              storeId={store.id}
              storeName={store.name}
              roles={roles}
              grantable={permissionOptions.filter((p) => viewer.grantable.includes(p.value))}
            />
          </div>
        }
      >
        Each store has one owner. A person can own multiple stores.
      </PageHead>

      <StoreCards stores={stores} currentId={store.id} />

      <div className="bg-paper border-line rounded-card min-w-0 border p-[22px] max-md:p-[18px]">
        <div className="mb-5 flex items-center justify-between gap-2.5">
          <div className="min-w-0">
            <h2 className="text-[19px] leading-[1.35] font-bold tracking-[-0.4px] [overflow-wrap:anywhere]">
              Members of {store.name}
            </h2>
            <p className="text-muted mt-[5px] text-[12px]">
              {viewingAs(viewer)} <span className="whitespace-nowrap">{store.domain}</span>
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center rounded-[4px] bg-[#e8e9e6] px-[7px] py-[3px] text-[11.5px] font-semibold whitespace-nowrap text-[#565e58]">
            {members.length} {members.length === 1 ? 'member' : 'members'}
          </span>
        </div>
        <MemberTable storeId={store.id} storeName={store.name} members={rows} roles={roles} permissions={permissionOptions} />
        <div className="bg-soft text-teal mt-5 flex items-center gap-3 rounded-lg px-4 py-3 text-[13px] max-md:items-start max-md:p-3 max-md:text-[12.5px]">
          <p>Publish permission is granted separately, not by job title. Only the store owner can grant it.</p>
        </div>
      </div>

      {viewer.canManage && (
        <div className="mt-[22px] grid grid-cols-[minmax(0,1.7fr)_minmax(260px,1fr)] gap-6 max-lg:grid-cols-[minmax(0,1.45fr)_minmax(220px,1fr)] max-lg:gap-[18px] max-md:grid-cols-1">
          <PendingInvites storeId={store.id} invites={pending} />
          <section
            aria-labelledby="accounts-without-sso"
            className="bg-paper border-line rounded-card min-w-0 border p-[22px] max-md:p-[18px]"
          >
            <h2 id="accounts-without-sso" className="text-[15px] leading-[1.4] font-bold">
              Accounts without SSO
            </h2>
            <p className="text-muted mt-3 text-[12.5px] text-pretty">
              Admins create accounts with a temporary password, or invitees set their name and password. Public
              registration is closed.
            </p>
          </section>
        </div>
      )}
    </section>
  );
}