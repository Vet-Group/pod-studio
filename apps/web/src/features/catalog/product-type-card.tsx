'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useHydrated } from '@/lib/use-hydrated';
import { ProductTypeForm } from './product-type-form';
import { PricingTable } from './pricing-table';
import type { ProductTypeView } from './types';

/** Type and price drafts share a revision. Save one before editing the other to avoid losing drafts. */
export function ProductTypeCard({
  storeId,
  type,
  canEdit,
  onSaved,
}: {
  storeId: string;
  type: ProductTypeView;
  canEdit: boolean;
  onSaved: (types: ProductTypeView[], message: string) => void;
}) {
  const hydrated = useHydrated();
  const [priceDirty, setPriceDirty] = useState(false);
  const [typeDirty, setTypeDirty] = useState(false);
  const [formKey, setFormKey] = useState(0);
  return (
    <section className="bg-paper border-line rounded-xl border p-4 sm:p-5">
      <PricingTable
        storeId={storeId}
        type={type}
        canEdit={canEdit}
        onSaved={onSaved}
        blocked={typeDirty}
        onDirtyChange={setPriceDirty}
      />
      {canEdit ? (
        <details className="border-line mt-5 border-t pt-4">
          <summary className="text-muted min-h-11 cursor-pointer text-[13px] font-semibold">
            Edit product type options
          </summary>
          {priceDirty && (
            <p className="text-muted text-[13px]">Save or discard price changes before editing this product type.</p>
          )}
          {typeDirty && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-muted text-[13px]">Save or discard type changes before editing prices.</p>
              <Button
                type="button"
                className="min-h-11"
                disabled={!hydrated}
                onClick={() => {
                  setTypeDirty(false);
                  setFormKey(formKey + 1);
                }}
              >
                Discard type changes
              </Button>
            </div>
          )}
          <div
            className="mt-3"
            onChangeCapture={() => setTypeDirty(true)}
            onClickCapture={(event) => {
              const button = (event.target as HTMLElement).closest('button');
              if (
                button?.textContent === 'Add option' ||
                button?.getAttribute('aria-label')?.startsWith('Remove option')
              )
                setTypeDirty(true);
            }}
          >
            <ProductTypeForm key={formKey} storeId={storeId} type={type} onSaved={onSaved} blocked={priceDirty} />
          </div>
        </details>
      ) : (
        <p className="text-muted mt-4 text-[13px]">
          Options: {type.options.map((option) => `${option.name} (${option.values.join(', ')})`).join(' · ')}
        </p>
      )}
    </section>
  );
}
