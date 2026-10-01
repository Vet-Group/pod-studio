import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AuthError, getShopifyConnection, listStores } from '@pod-studio/core';
import { getDatabase } from '@/lib/auth';
import { requireAppSession } from '@/lib/session';
import { principalOf } from '@/lib/principal';
import { PageHead } from '@/components/page-head';
import { ShopifySettings } from '@/features/stores/shopify-settings';

export default async function StoreSettingsPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  const session = await requireAppSession(`/stores/${storeId}/settings`);
  const principal = principalOf(session.user);
  const db = getDatabase();
  const store = (await listStores(db, principal)).find((entry) => entry.id === storeId);
  if (!store) notFound();
  let connection;
  try { connection = await getShopifyConnection(db, principal, storeId); }
  catch (error) {
    if (error instanceof AuthError && error.code === 'FORBIDDEN') notFound();
    throw error;
  }
  return <section className="space-y-6">
    <Link href="/stores" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">All stores</Link>
    <PageHead eyebrow="Store settings" title={`${store.name} settings`} actions={<Link className="text-sm text-teal hover:underline" href={`/stores/${storeId}/members`}>Members &amp; access</Link>}>
      {store.domain}
    </PageHead>
    <ShopifySettings storeId={storeId} connection={connection} />
  </section>;
}
