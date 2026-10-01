'use client';

import { useState } from 'react';
import { ProductTypeForm } from './product-type-form';
import { ProductTypeCard } from './product-type-card';
import { ShopifyImports } from './shopify-imports';
import type { listShopifyImports } from '@pod-studio/core';
import type { ProductTypeView } from './types';

export function CatalogEditor({
  storeId,
  initialTypes,
  canEdit,
  imports,
}: {
  storeId: string;
  initialTypes: ProductTypeView[];
  canEdit: boolean;
  imports: Awaited<ReturnType<typeof listShopifyImports>>;
}) {
  const [types, setTypes] = useState(initialTypes);
  const [message, setMessage] = useState('');
  function saved(next: ProductTypeView[], notice: string) {
    setTypes(next);
    setMessage(notice);
  }
  return (
    <div className="space-y-5">
      <ShopifyImports storeId={storeId} types={types} initial={imports} />
      <div role="status" aria-live="polite" className="text-teal text-[13px] font-semibold empty:hidden">
        {message}
      </div>
      {!canEdit && (
        <p className="bg-soft border-line rounded-lg border p-4 text-[13px]">
          Read-only: store.settings is required to edit.
        </p>
      )}
      {types.length === 0 && (
        <section className="bg-paper border-line rounded-xl border p-6">
          <h2 className="text-[17px] font-bold">No product types yet</h2>
          <p className="text-muted mt-1 text-[13px]">
            {canEdit
              ? 'Create your first product type below, then add its price rows.'
              : 'Ask the store owner to configure product types and prices.'}
          </p>
        </section>
      )}
      {types.map((type) => (
        <ProductTypeCard
          key={`${type.id}:${type.revision}`}
          storeId={storeId}
          type={type}
          canEdit={canEdit}
          onSaved={saved}
        />
      ))}
      {canEdit && (
        <section className="bg-paper border-line rounded-xl border p-4 sm:p-5">
          <h2 className="mb-4 text-[17px] font-bold">New product type</h2>
          <ProductTypeForm storeId={storeId} onSaved={saved} />
        </section>
      )}
    </div>
  );
}
