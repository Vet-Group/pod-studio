'use client';

import { useId, useState, useTransition } from 'react';
import type { CatalogIssue } from '@pod-studio/core';
import { FormAlert } from '@/components/auth/field';
import { Button } from '@/components/ui/button';
import { useHydrated } from '@/lib/use-hydrated';
import { savePricesAction } from './actions';
import type { ProductTypeView } from './types';

interface DraftRow {
  key: string;
  id?: string;
  optionValues: Record<string, string>;
  price: string;
  markets: string;
}
export function PricingTable({
  storeId,
  type,
  canEdit,
  onSaved,
  blocked = false,
  onDirtyChange,
}: {
  storeId: string;
  type: ProductTypeView;
  canEdit: boolean;
  onSaved: (types: ProductTypeView[], message: string) => void;
  blocked?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const id = useId();
  const hydrated = useHydrated();
  const [pending, startTransition] = useTransition();
  const [rows, setRows] = useState<DraftRow[]>(
    type.rows.map((row) => ({
      ...row,
      key: row.id,
      markets: row.excludedMarkets.join(', '),
    })),
  );
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<CatalogIssue[]>([]);
  const disabled = !canEdit || !hydrated || pending || blocked;
  function edit(next: DraftRow[]) {
    setRows(next);
    setDirty(true);
    onDirtyChange?.(true);
    setError(null);
    setIssues([]);
  }
  function update(index: number, patch: Partial<DraftRow>) {
    edit(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }
  function move(index: number, offset: number) {
    const next = [...rows];
    [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
    edit(next);
  }
  function invalid(index: number, field: string) {
    return issues.some((issue) => issue.row === index && issue.field === field);
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-bold">Price table: {type.name}</h2>
          <p className="text-muted mt-1 text-[13px]">
            {rows.length} rows = {rows.length} variants
          </p>
        </div>
        <span className="bg-teal-light text-teal rounded-full px-3 py-1.5 text-[12px] font-semibold">
          {type.currency} · {dirty ? 'Unsaved changes' : 'Saved table'}
        </span>
      </div>
      <p className="text-muted text-[13px]">
        One row, one variant. Use Tab to move between cells. Row order is the variant order. Excluded markets apply only
        to their row.
      </p>
      <FormAlert message={error} />
      {!rows.length ? (
        <div className="bg-soft border-line rounded-lg border border-dashed p-6 text-center">
          <p className="font-semibold">No price rows yet</p>
          <p className="text-muted mt-1 text-[13px]">
            {canEdit
              ? 'Add a row and choose each option to define the first variant.'
              : 'The store owner has not configured variants yet.'}
          </p>
        </div>
      ) : (
        <div className="catalog-table-wrap">
          <table className="catalog-table w-full text-left text-[13px]">
            <caption className="sr-only">{type.name} price rows in variant order</caption>
            <thead className="bg-soft text-muted text-[12px]">
              <tr>
                <th scope="col">Order</th>
                {type.options.map((option) => (
                  <th key={option.name} scope="col">
                    {option.name}
                  </th>
                ))}
                <th scope="col">Price ({type.currency})</th>
                <th scope="col">Excluded markets</th>
                {canEdit && <th scope="col">Row actions</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.key} className="border-line border-t">
                  <td data-label="Order">
                    <span className="text-muted font-semibold">{index + 1}</span>
                  </td>
                  {type.options.map((option, optionIndex) => (
                    <td key={option.name} data-label={option.name}>
                      <select
                        className="catalog-input"
                        aria-label={`Row ${index + 1} ${option.name}`}
                        aria-invalid={invalid(index, option.name) || undefined}
                        aria-describedby={invalid(index, option.name) ? `${id}-errors` : undefined}
                        value={row.optionValues[option.name] ?? ''}
                        disabled={disabled}
                        onChange={(event) =>
                          update(index, {
                            optionValues: {
                              ...row.optionValues,
                              [option.name]: event.target.value,
                            },
                          })
                        }
                        data-option={optionIndex}
                      >
                        <option value="">Choose {option.name}</option>
                        {option.values.map((value) => (
                          <option key={value}>{value}</option>
                        ))}
                      </select>
                    </td>
                  ))}
                  <td data-label={`Price (${type.currency})`}>
                    <input
                      className="catalog-input tabular-nums"
                      aria-label={`Row ${index + 1} price`}
                      aria-invalid={invalid(index, 'price') || undefined}
                      value={row.price}
                      inputMode="decimal"
                      placeholder="0.00"
                      disabled={disabled}
                      onChange={(event) => update(index, { price: event.target.value })}
                    />
                  </td>
                  <td data-label="Excluded markets">
                    <input
                      className="catalog-input"
                      aria-label={`Row ${index + 1} excluded markets`}
                      aria-invalid={invalid(index, 'excludedMarkets') || undefined}
                      value={row.markets}
                      placeholder="e.g. DE, FR"
                      disabled={disabled}
                      onChange={(event) => update(index, { markets: event.target.value })}
                    />
                  </td>
                  {canEdit && (
                    <td data-label="Row actions">
                      <div className="flex gap-1">
                        <Button
                          type="button"
                          className="min-h-11 min-w-11 px-2"
                          aria-label={`Move row ${index + 1} up`}
                          disabled={disabled || index === 0}
                          onClick={() => move(index, -1)}
                        >
                          <span aria-hidden="true">↑</span>
                        </Button>
                        <Button
                          type="button"
                          className="min-h-11 min-w-11 px-2"
                          aria-label={`Move row ${index + 1} down`}
                          disabled={disabled || index === rows.length - 1}
                          onClick={() => move(index, 1)}
                        >
                          <span aria-hidden="true">↓</span>
                        </Button>
                        <Button
                          type="button"
                          className="min-h-11 min-w-11 px-2"
                          aria-label={`Remove row ${index + 1}`}
                          disabled={disabled}
                          onClick={() => edit(rows.filter((_, i) => i !== index))}
                        >
                          <span aria-hidden="true">×</span>
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {issues.length > 0 && (
        <ul id={`${id}-errors`} className="text-orange list-inside list-disc text-[13px]">
          {issues.map((issue, i) => (
            <li key={i}>{issue.message}</li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            className="min-h-11"
            disabled={disabled || rows.length >= 500}
            onClick={() =>
              edit([
                ...rows,
                {
                  key: crypto.randomUUID(),
                  optionValues: {},
                  price: '',
                  markets: '',
                },
              ])
            }
          >
            Add price row
          </Button>
          <Button
            type="button"
            variant="primary"
            className="min-h-11"
            disabled={disabled || !dirty}
            onClick={() => {
              setError(null);
              setIssues([]);
              startTransition(async () => {
                const result = await savePricesAction(storeId, type.id, {
                  revision: type.revision,
                  rows: rows.map((row) => ({
                    id: row.id,
                    optionValues: row.optionValues,
                    price: row.price,
                    excludedMarkets: row.markets
                      .split(',')
                      .map((market) => market.trim().toUpperCase())
                      .filter(Boolean),
                  })),
                });
                if (!result.ok) {
                  setError(result.error);
                  setIssues(result.issues);
                  return;
                }
                onSaved(
                  result.data,
                  `Price table saved. ${rows.length} variant${rows.length === 1 ? '' : 's'} configured.`,
                );
              });
            }}
          >
            {pending ? 'Saving…' : 'Save price table'}
          </Button>
          <Button
            type="button"
            className="min-h-11"
            disabled={disabled || !dirty}
            onClick={() => {
              setRows(
                type.rows.map((row) => ({
                  ...row,
                  key: row.id,
                  markets: row.excludedMarkets.join(', '),
                })),
              );
              setDirty(false);
              onDirtyChange?.(false);
              setError(null);
              setIssues([]);
            }}
          >
            Discard changes
          </Button>
        </div>
      )}
    </div>
  );
}
