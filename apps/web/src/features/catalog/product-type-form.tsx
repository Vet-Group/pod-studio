'use client';

import { useId, useState, useTransition } from 'react';
import { CATALOG_CURRENCIES } from './currency';
import { Field, FormAlert } from '@/components/auth/field';
import { Button } from '@/components/ui/button';
import { useHydrated } from '@/lib/use-hydrated';
import { createTypeAction, updateTypeAction } from './actions';
import type { ProductTypeView } from './types';

interface Props {
  storeId: string;
  blocked?: boolean;
  type?: ProductTypeView;
  onSaved: (types: ProductTypeView[], message: string) => void;
}
export function ProductTypeForm({ storeId, type, onSaved, blocked = false }: Props) {
  const id = useId();
  const hydrated = useHydrated();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(type?.name ?? '');
  const [currency, setCurrency] = useState(type?.currency ?? 'USD');
  const [options, setOptions] = useState(
    type?.options.map((option) => ({
      name: option.name,
      values: option.values.join(', '),
    })) ?? [{ name: '', values: '' }],
  );
  const [error, setError] = useState<string | null>(null);
  const disabled = !hydrated || pending || blocked;
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        const input = {
          name,
          currency,
          options: options.map((option) => ({
            name: option.name,
            values: option.values
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean),
          })),
        };
        startTransition(async () => {
          const result = type
            ? await updateTypeAction(storeId, type.id, {
                ...input,
                revision: type.revision,
              })
            : await createTypeAction(storeId, input);
          if (!result.ok) {
            setError(result.error);
            return;
          }
          onSaved(
            result.data,
            type ? 'Product type saved.' : 'Product type created. Add price rows to define its variants.',
          );
          if (!type) {
            setName('');
            setOptions([{ name: '', values: '' }]);
          }
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
        <Field
          label="Product type name"
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
          disabled={disabled}
        />
        <div>
          <label htmlFor={`${id}-currency`} className="block text-[13px] font-semibold">
            Currency
          </label>
          <select
            id={`${id}-currency`}
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
            disabled={disabled}
            className="catalog-input mt-[7px]"
          >
            {CATALOG_CURRENCIES.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </div>
      </div>
      {options.map((option, index) => (
        <div key={index} className="grid items-end gap-3 sm:grid-cols-[1fr_2fr_auto]">
          <Field
            label={`Option ${index + 1} name`}
            value={option.name}
            maxLength={50}
            placeholder="e.g. Size"
            disabled={disabled}
            onChange={(event) =>
              setOptions(options.map((entry, i) => (i === index ? { ...entry, name: event.target.value } : entry)))
            }
          />
          <Field
            label={`Option ${index + 1} values`}
            value={option.values}
            placeholder="e.g. S, M, L"
            disabled={disabled}
            onChange={(event) =>
              setOptions(options.map((entry, i) => (i === index ? { ...entry, values: event.target.value } : entry)))
            }
          />
          <Button
            type="button"
            className="min-h-11"
            aria-label={`Remove option ${index + 1}`}
            disabled={disabled || options.length === 1}
            onClick={() => setOptions(options.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      <p className="text-muted text-[13px]">
        Comma-separated values. All options are required in each price row. Options do not automatically create
        variants.
      </p>
      <FormAlert message={error} />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          className="min-h-11"
          disabled={disabled || options.length >= 3}
          onClick={() => setOptions([...options, { name: '', values: '' }])}
        >
          Add option
        </Button>
        <Button type="submit" variant="primary" className="min-h-11" disabled={disabled}>
          {pending ? 'Saving…' : type ? 'Save product type' : 'Create product type'}
        </Button>
      </div>
    </form>
  );
}
