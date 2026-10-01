'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, useTransition, type FormEvent } from 'react';
import { Field, FormAlert } from '@/components/auth/field';
import { Button } from '@/components/ui/button';
import { createStoreAction } from '@/features/stores/actions';
import { Modal, SelectField } from '@/features/stores/modal';
import type { AccountChoice } from '@/features/stores/types';
import { useHydrated } from '@/lib/use-hydrated';

/** "+ New store" for admins: name, Shopify domain and the single owner (ADR 0002). */
export function CreateStoreDialog({ accounts }: { accounts: AccountChoice[] }) {
  const titleId = useId();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [owner, setOwner] = useState(accounts[0]?.userId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // The trigger is server-rendered; a click before hydration would do nothing.
  const hydrated = useHydrated();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    startTransition(async () => {
      try {
        const result = await createStoreAction({
          name: String(form.get('name') ?? ''),
          domain: String(form.get('domain') ?? ''),
          ownerUserId: owner,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setOpen(false);
        router.push(`/stores/${result.data.storeId}/members`);
      } catch {
        setError('Something went wrong. Reload the page and try again.');
      }
    });
  }

  return (
    <>
      <Button
        variant="primary"
        disabled={!hydrated}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        + New store
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} labelledBy={titleId}>
        <h2 id={titleId} className="text-[19px] leading-[1.35] font-bold tracking-[-0.4px]">
          New store
        </h2>
        <form onSubmit={onSubmit} className="mt-4 grid gap-5">
          <FormAlert message={error} />
          <Field label="Store name" name="name" required maxLength={100} autoComplete="off" autoFocus />
          <Field
            label="Shopify domain"
            name="domain"
            required
            autoComplete="off"
            placeholder="your-shop.myshopify.com"
            hint="The store's .myshopify.com address."
          />
          <SelectField label="Store owner" value={owner} onChange={setOwner} disabled={pending}>
            {accounts.map((a) => (
              <option key={a.userId} value={a.userId}>
                {a.name} ({a.email})
              </option>
            ))}
          </SelectField>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending || !owner}>
              {pending ? 'Creating…' : 'Create store'}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
