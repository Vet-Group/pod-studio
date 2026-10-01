import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatPrice, isAuthError, listCatalog, listShopifyImports, listStores } from '@pod-studio/core';
import { PageHead } from '@/components/page-head';
import { Button } from '@/components/ui/button';
import { CatalogEditor } from '@/features/catalog/catalog-editor';
import { getDatabase } from '@/lib/auth';
import { principalOf } from '@/lib/principal';
import { requireAppSession } from '@/lib/session';

export const metadata: Metadata = { title: 'Store catalog' };
export default async function CatalogPage({ params }: PageProps<'/stores/[storeId]/catalog'>) {
  const { storeId } = await params;
  const session = await requireAppSession(`/stores/${storeId}/catalog`);
  const db = getDatabase();
  const principal = principalOf(session.user);
  const data = await listCatalog(db, principal, storeId).catch((error: unknown) => {
    if (isAuthError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  });
  const store = (await listStores(db, principal)).find((store) => store.id === storeId);
  if (!store) notFound();
  const imports = await listShopifyImports(db, principal, storeId);
  const types = data.types.map((type) => ({
    id: type.id,
    name: type.name,
    currency: type.currency,
    options: type.options,
    revision: type.revision,
    rows: type.rows.map((row) => ({
      id: row.id,
      optionValues: row.optionValues,
      price: formatPrice(row.priceMinor),
      excludedMarkets: row.excludedMarkets,
    })),
  }));
  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHead
        title="Catalog"
        eyebrow={`Product types & price tables · ${store.name}`}
        actions={
          <div className="flex gap-2">
            <Button asChild className="min-h-11">
              <Link href="/stores">All stores</Link>
            </Button>
            <Button asChild className="min-h-11">
              <Link href={`/stores/${storeId}/members`}>Members</Link>
            </Button>
          </div>
        }
      >
        Configure exact variants and row-level market exclusions for this store. Nothing is sent to Shopify.
      </PageHead>
      <CatalogEditor storeId={storeId} initialTypes={types} canEdit={data.canEdit} imports={imports} />
    </div>
  );
}
