'use client';

import { useId, useState, useTransition, type FormEvent } from 'react';
import { Field, FormAlert } from '@/components/auth/field';
import { Button } from '@/components/ui/button';
import { inviteMemberAction, type InviteOutcome } from '@/features/stores/actions';
import { Modal, SelectField } from '@/features/stores/modal';
import type { PermissionOption, RoleOption } from '@/features/stores/types';
import { useHydrated } from '@/lib/use-hydrated';
import type { StorePermission } from '@pod-studio/core';

/**
 * "+ Invite member": email, store role and the permissions that come with it. Someone with an account
 * is added at once; anyone else gets a single-use link, shown here once to copy. Choices are limited
 * to what the viewer may grant (listMembers.viewer); the server applies the same rules again.
 */
export function InviteDialog({
  storeId,
  storeName,
  roles,
  grantable,
}: {
  storeId: string;
  storeName: string;
  roles: RoleOption[];
  grantable: PermissionOption[];
}) {
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState(roles[0]?.value ?? '');
  const [permissions, setPermissions] = useState<StorePermission[]>(roles[0]?.permissions ?? []);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<(InviteOutcome & { link?: string }) | null>(null);
  const [copied, setCopied] = useState(false);
  // Remounts the form so a reopened dialog starts with an empty email field.
  const [round, setRound] = useState(0);
  const [pending, startTransition] = useTransition();
  // The trigger is server-rendered; a click before hydration would do nothing.
  const hydrated = useHydrated();

  function reset() {
    setRound((n) => n + 1);
    setRole(roles[0]?.value ?? '');
    setPermissions(roles[0]?.permissions ?? []);
    setError(null);
    setOutcome(null);
    setCopied(false);
  }

  function chooseRole(value: string) {
    const option = roles.find((r) => r.value === value);
    if (!option) return;
    setRole(option.value);
    setPermissions(option.permissions);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get('email') ?? '');
    setError(null);
    startTransition(async () => {
      try {
        const result = await inviteMemberAction(storeId, { email, role, permissions });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        const data = result.data;
        setOutcome(data.kind === 'invited' ? { ...data, link: new URL(data.path, window.location.origin).href } : data);
      } catch {
        setError('Something went wrong. Reload the page and try again.');
      }
    });
  }

  if (roles.length === 0) return null;

  return (
    <>
      <Button
        variant="primary"
        disabled={!hydrated}
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        + Invite member
      </Button>
      <Modal
        open={open}
        onClose={() => {
          // Drop the one-time link from the DOM as soon as the dialog closes (Done, Cancel or Escape).
          setOpen(false);
          reset();
        }}
        labelledBy={titleId}
      >
        <h2 id={titleId} className="text-[19px] leading-[1.35] font-bold tracking-[-0.4px]">
          {outcome ? (outcome.kind === 'added' ? 'Member added' : 'Invite link ready') : `Invite to ${storeName}`}
        </h2>

        {outcome ? (
          <div className="mt-4 grid gap-4">
            {outcome.kind === 'added' ? (
              <p className="text-[13px] text-pretty">
                <b>{outcome.email}</b> already has an account and can open {storeName} now.
              </p>
            ) : (
              <>
                <p className="text-[13px] text-pretty">
                  Send this link to <b>{outcome.email}</b>. It works once and expires on{' '}
                  {outcome.expiresAt.slice(0, 10)}. It is shown only now.
                </p>
                <Field label="Invite link" value={outcome.link} readOnly onFocus={(e) => e.currentTarget.select()} />
                <p role="status" className="text-teal min-h-5 text-[12.5px] font-semibold">
                  {copied ? 'Link copied.' : ''}
                </p>
              </>
            )}
            <div className="flex justify-end gap-2">
              {outcome.kind === 'invited' && (
                <Button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(outcome.link ?? '');
                      setCopied(true);
                    } catch {
                      setCopied(false);
                    }
                  }}
                >
                  Copy link
                </Button>
              )}
              <Button type="button" variant="primary" onClick={() => setOpen(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form key={round} onSubmit={onSubmit} className="mt-4 grid gap-5">
            <p className="text-muted -mt-1 text-[13px] text-pretty">
              Existing accounts join at once. Anyone else gets a single-use link valid for 7 days. Public sign-up
              stays closed.
            </p>
            <FormAlert message={error} />
            <Field label="Email" name="email" type="email" required autoComplete="off" maxLength={254} autoFocus />
            <SelectField label="Store role" value={role} onChange={chooseRole} disabled={pending}>
              {roles.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </SelectField>
            <fieldset className="min-w-0">
              <legend className="text-[13px] font-semibold">Permissions</legend>
              <p className="text-muted mt-1 text-[12.5px]">
                The role fills these in. Shopify publish can only be granted by the store owner.
              </p>
              <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2 max-md:grid-cols-1">
                {grantable.map((p) => (
                  <label key={p.value} className="inline-flex min-h-7 items-center gap-2 text-[13px] font-normal">
                    <input
                      type="checkbox"
                      className="accent-teal size-[17px]"
                      checked={permissions.includes(p.value)}
                      disabled={pending}
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        setPermissions((cur) => (on ? [...cur, p.value] : cur.filter((x) => x !== p.value)));
                      }}
                    />
                    {p.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex justify-end gap-2">
              <Button type="button" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={pending}>
                {pending ? 'Sending…' : 'Send invite'}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
