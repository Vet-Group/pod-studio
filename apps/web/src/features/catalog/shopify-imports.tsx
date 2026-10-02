'use client';

import { useEffect, useState, useTransition } from 'react';
import type { listShopifyImports } from '@pod-studio/core';
import { Button } from '@/components/ui/button';
import { useHydrated } from '@/lib/use-hydrated';
import { cn } from '@/lib/utils';
import { importShopifyAction, resyncVariantsAction } from './import-actions';

type ImportState = Awaited<ReturnType<typeof listShopifyImports>>;
function runLabel(run: ImportState['runs'][number]) {
  switch (run.status) {
    case 'queued': return 'Queued';
    case 'running': return 'Importing';
    case 'failed': return 'Failed';
    case 'done': return run.errors.length ? 'Completed with errors' : 'Completed';
  }
}
export function ShopifyImports({
  storeId,
  types,
  initial,
}: {
  storeId: string;
  types: Array<{ id: string; name: string }>;
  initial: ImportState;
}) {
  const hydrated = useHydrated();
  const [data, setData] = useState(initial);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, startTransition] = useTransition();
  const [watch, setWatch] = useState(false);
  const activeRun = data.runs.find((r) => r.status === 'queued' || r.status === 'running');
  const active = !!activeRun;
  useEffect(() => {
    if (!active && !watch) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const response = await fetch(`/api/stores/${encodeURIComponent(storeId)}/imports`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error();
        const next = (await response.json()) as ImportState;
        if (!controller.signal.aborted) {
          setData(next);
          setWatch(false);
        }
      } catch {
        if (!controller.signal.aborted) setError('Unable to refresh import progress. Reload the page to retry.');
      }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 1500);
    }
    timer = setTimeout(refresh, 500);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, watch, storeId]);
  const typeName = (id: string) => types.find((t) => t.id === id)?.name ?? 'Product type';
  return (
    <section aria-label="Shopify imports" className="bg-paper border-line mb-5 rounded-xl border p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-bold">Shopify imports</h2>
          <p className="text-muted mt-1 text-[13px]">
            Import existing listings. Variants use the current price table; no images or SKUs are imported.
          </p>
        </div>
        <span className="bg-soft rounded-md px-2 py-1 text-xs font-semibold">
          {data.connected ? 'Shopify configured' : 'Not connected'}
        </span>
      </div>
      {!data.canEdit && (
        <p className="text-muted mt-3 text-[13px]">Read-only: product.edit is required to import or resync.</p>
      )}
      {data.canEdit && !data.connected && (
        <p className="text-muted mt-3 text-[13px]">Connect Shopify in store settings to import.</p>
      )}
      {!types.length && (
        <p className="text-muted mt-3 text-[13px]">Create a product type and its price table before importing.</p>
      )}
      {data.canEdit && (
        <ul className="mt-4 space-y-2">
          {types.map((type) => {
            const busy = active;
            return (
              <li key={type.id} className="border-line flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                <span className="min-w-0 break-words text-sm font-semibold">{type.name}</span>
                <Button
                  className="min-h-11"
                  disabled={!hydrated || pending || !data.connected || busy}
                  onClick={() => {
                    setError('');
                    setNotice('');
                    startTransition(async () => {
                      const result = await importShopifyAction(storeId, type.id);
                      if (!result.ok) setError(result.error);
                      else {
                        setWatch(true);
                        setData((previous) => ({
                          ...previous,
                          runs: [
                            {
                              id: result.runId,
                              ref: type.id,
                              status: 'queued' as const,
                              imported: 0,
                              skipped: 0,
                              totalRows: 0,
                              errors: [],
                            },
                            ...previous.runs,
                          ].slice(0, 10),
                        }));
                      }
                    });
                  }}
                >
                  Import from Shopify
                </Button>
                {busy && (
                  <p className="text-muted w-full text-xs">
                    {activeRun ? typeName(activeRun.ref) : 'Product type'} is importing. Wait for it to finish before starting another import for this store.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p role="alert" className="text-orange mt-3 text-sm empty:hidden">
        {error}
      </p>
      <p role="status" className="text-teal mt-3 text-sm empty:hidden">
        {notice}
      </p>
      <div className="border-line mt-4 border-t pt-4">
        <h3 className="text-sm font-semibold">Recent import runs</h3>
        {!data.runs.length && (
          <p className="text-muted mt-2 text-[13px]">No imports yet. Existing Shopify products stay unchanged.</p>
        )}
        <ul className="mt-2 space-y-3">
          {data.runs.map((run) => (
            <li key={run.id} className="bg-soft rounded-lg p-3 text-[13px]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">{typeName(run.ref)}</span>
                <span className={cn('font-semibold', {
                  'text-orange': run.status === 'failed' || (run.status === 'done' && run.errors.length > 0),
                  'text-teal': run.status === 'running',
                })}>
                  {runLabel(run)}
                </span>
              </div>
              {!!run.errors.length && (
                <p className="text-orange mt-1 font-semibold">
                  {run.errors.length} {run.errors.length === 1 ? 'product error' : 'product errors'}
                </p>
              )}
              <p className="text-muted mt-1 tabular-nums">
                {run.imported} imported · {run.skipped} skipped · {run.totalRows} processed
              </p>
              {(run.status === 'queued' || run.status === 'running') && (
                <p className="text-muted mt-1">Refreshing automatically. Total grows as Shopify pages are processed.</p>
              )}
              {!!run.errors.length && (
                <details className="mt-2">
                  <summary className="text-orange min-h-11 cursor-pointer font-semibold">
                    Error log ({run.errors.length})
                  </summary>
                  <ul className="space-y-1 break-words">
                    {run.errors.map((message, index) => (
                      <li key={index}>{message}</li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          ))}
        </ul>
      </div>
      <div className="border-line mt-4 border-t pt-4">
        <h3 className="text-sm font-semibold">Catalog products ({data.productCount})</h3>
        {data.productCount > data.products.length && (
          <p className="text-muted mt-2 text-[13px]">Showing the 50 most recent catalog products.</p>
        )}
        {!data.products.length && <p className="text-muted mt-2 text-[13px]">No catalog products yet.</p>}
        <ul className="mt-2 space-y-2">
          {data.products.map((product) => (
            <li
              key={product.id}
              className="border-line flex flex-wrap items-center justify-between gap-2 border-t py-2"
            >
              <div className="min-w-0">
                <p className="break-words text-sm font-semibold">{product.title}</p>
                <p className="text-muted text-xs">
                  {typeName(product.productTypeId)} · {product.status}
                </p>
              </div>
              {data.canEdit && (
                <Button
                  className="min-h-11"
                  aria-label={`Resync variants for ${product.title}`}
                  disabled={!hydrated || pending}
                  onClick={() => {
                    setError('');
                    setNotice('');
                    startTransition(async () => {
                      const result = await resyncVariantsAction(storeId, product.id);
                      if (!result.ok) setError(result.error);
                      else setNotice('Variants resynced from the current price table. SKU preserved.');
                    });
                  }}
                >
                  Resync variants
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
