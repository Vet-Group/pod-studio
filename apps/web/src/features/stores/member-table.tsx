'use client';

import { useId, useState, useTransition } from 'react';
import { FormAlert } from '@/components/auth/field';
import { Button } from '@/components/ui/button';
import { removeMemberAction, setPermissionAction, setRoleAction, transferOwnershipAction } from '@/features/stores/actions';
import { Avatar, initials } from '@/features/stores/avatar';
import { Modal } from '@/features/stores/modal';
import type { PermissionOption, RoleOption } from '@/features/stores/types';
import { useHydrated } from '@/lib/use-hydrated';
import type { StorePermission, StoreRole } from '@pod-studio/core';

export interface MemberView {
  userId: string;
  name: string;
  email: string;
  role: StoreRole;
  roleLabel: string;
  permissions: StorePermission[];
  isSelf: boolean;
  can: { toggle: StorePermission[]; edit: boolean; remove: boolean; makeOwner: boolean };
}

type Confirm = { kind: 'transfer' | 'remove'; member: MemberView } | null;

/** Draft push and Shopify publish get their own columns, like the wireframe table. */
const KEY_PERMISSIONS: readonly StorePermission[] = ['product.push', 'product.publish'];

/** Wireframe `td` spacing, with the `.dense` 10px sides so the table fits at 1280px. */
const cell = 'border-line border-b px-2.5 py-[15px] align-top';
const head = cell.replace('py-[15px]', 'py-3') + ' bg-bg text-muted text-left text-[11.5px] font-semibold tracking-[1px] uppercase';

/**
 * Members of one store with their role and permissions. Controls appear only where `can` (from
 * listMembers in @pod-studio/core) allows them; every action is checked again on the server.
 */
export function MemberTable({
  storeId,
  storeName,
  members,
  roles,
  permissions,
}: {
  storeId: string;
  storeName: string;
  members: MemberView[];
  /** Roles the viewer may assign (presets they can grant in full). */
  roles: RoleOption[];
  permissions: PermissionOption[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Server-rendered controls ignore input until React hydrates; keep them disabled until then.
  const hydrated = useHydrated();
  const locked = !hydrated || busy !== null;
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [, startTransition] = useTransition();
  const confirmTitle = useId();

  const others = permissions.filter((p) => !KEY_PERMISSIONS.includes(p.value));
  const byValue = new Map(permissions.map((p) => [p.value, p]));

  function act(key: string, action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null);
    setBusy(key);
    startTransition(async () => {
      try {
        // A redirect from the action (leaving the store) resolves without a result.
        const result = await action();
        if (result?.ok === false) setError(result.error);
      } catch {
        setError('Something went wrong. Reload the page and try again.');
      } finally {
        setBusy(null);
      }
    });
  }

  function checkbox(member: MemberView, option: PermissionOption) {
    const key = `${member.userId}:${option.value}`;
    const checked = member.permissions.includes(option.value);
    const editable = member.can.toggle.includes(option.value);
    return (
      <label
        key={option.value}
        className="inline-flex min-h-7 items-center gap-2 text-[13px] font-normal whitespace-nowrap has-disabled:cursor-not-allowed has-disabled:opacity-60"
      >
        <input
          type="checkbox"
          className="accent-teal size-[17px]"
          checked={checked}
          disabled={!editable || locked}
          aria-busy={busy === key}
          aria-label={`${option.label} for ${member.name}`}
          onChange={(e) => {
            const enabled = e.currentTarget.checked;
            act(key, () => setPermissionAction(storeId, member.userId, option.value, enabled));
          }}
        />
        <span aria-hidden="true">{option.label}</span>
      </label>
    );
  }

  function roleCell(member: MemberView) {
    if (member.role === 'owner') {
      return (
        <span className="inline-flex items-center rounded-[4px] bg-[#dbe6d5] px-[7px] py-[3px] text-[11.5px] font-semibold whitespace-nowrap text-[#2f5a3c]">
          {member.roleLabel}
        </span>
      );
    }
    if (!member.can.edit || roles.length === 0) return member.roleLabel;
    // Keep the current role selectable-as-shown even when the viewer could not assign it.
    const assignable = roles.some((r) => r.value === member.role)
      ? roles
      : [...roles, { value: member.role, label: member.roleLabel, permissions: [] }];
    return (
      <select
        aria-label={`Store role for ${member.name}`}
        value={member.role}
        disabled={locked}
        onChange={(e) => {
          const role = e.currentTarget.value;
          act(`${member.userId}:role`, () => setRoleAction(storeId, member.userId, role));
        }}
        className="border-line bg-paper text-ink w-full max-w-[180px] min-w-[136px] rounded-[7px] border px-2.5 py-[7px] text-[13px]"
      >
        {assignable.map((r) => (
          <option key={r.value} value={r.value} disabled={!roles.some((x) => x.value === r.value)}>
            {r.label}
          </option>
        ))}
      </select>
    );
  }

  const target = confirm?.member;

  return (
    <div>
      <FormAlert message={error} />
      <p className="text-muted mb-2 text-[12px] md:hidden">Swipe the table sideways to see every permission.</p>
      {/* `relative` keeps the visually hidden caption inside the scroll box on narrow screens. */}
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[880px] border-collapse text-[13px]">
          <caption className="sr-only">Members of {storeName}</caption>
          <thead>
            <tr>
              <th scope="col" className={head}>
                Member
              </th>
              <th scope="col" className={head}>
                Store role
              </th>
              {KEY_PERMISSIONS.map((p) => (
                <th key={p} scope="col" className={head}>
                  {byValue.get(p)?.label ?? p}
                </th>
              ))}
              <th scope="col" className={head}>
                Other permissions
              </th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.userId} className="[&:last-child>td]:border-b-0">
                <td className={`${cell} min-w-[240px]`}>
                  <div className="flex items-start gap-2.5">
                    <Avatar label={initials(m.name)} />
                    <div className="min-w-0">
                      <b className="block [overflow-wrap:anywhere]">
                        {m.name}
                        {m.isSelf && <span className="text-muted font-normal"> (you)</span>}
                      </b>
                      <small className="text-muted block text-[12px] [overflow-wrap:anywhere]">{m.email}</small>
                      {/* Row actions sit under the person (the wireframe table has no actions column). */}
                      {(m.can.makeOwner || m.can.remove) && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {m.can.makeOwner && (
                            <Button size="sm" disabled={locked} onClick={() => setConfirm({ kind: 'transfer', member: m })}>
                              Make owner
                            </Button>
                          )}
                          {m.can.remove && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-[#a94737]"
                              disabled={locked}
                              onClick={() => setConfirm({ kind: 'remove', member: m })}
                            >
                              {m.isSelf ? 'Leave store' : 'Remove'}
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </td>
                <td className={cell}>{roleCell(m)}</td>
                {KEY_PERMISSIONS.map((p) => (
                  <td key={p} className={cell}>
                    {checkbox(m, byValue.get(p) ?? { value: p, label: p })}
                  </td>
                ))}
                <td className={cell}>
                  <div className="grid grid-cols-[repeat(2,max-content)] gap-x-4 gap-y-1">{others.map((o) => checkbox(m, o))}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={confirm !== null} onClose={() => setConfirm(null)} labelledBy={confirmTitle}>
        {target && confirm && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const { kind, member } = confirm;
              setConfirm(null);
              act(`${member.userId}:${kind}`, () =>
                kind === 'transfer'
                  ? transferOwnershipAction(storeId, member.userId)
                  : removeMemberAction(storeId, member.userId),
              );
            }}
          >
            <h2 id={confirmTitle} className="text-[19px] leading-[1.35] font-bold tracking-[-0.4px]">
              {confirm.kind === 'transfer'
                ? `Make ${target.name} the owner of ${storeName}?`
                : target.isSelf
                  ? `Leave ${storeName}?`
                  : `Remove ${target.name} from ${storeName}?`}
            </h2>
            <p className="text-muted mt-2.5 text-[13px] text-pretty">
              {confirm.kind === 'transfer'
                ? 'A store has exactly one owner. The current owner becomes a co-leader, and only the new owner can grant Shopify publish.'
                : target.isSelf
                  ? 'You lose access to this store until someone adds you again.'
                  : `${target.name} loses access to this store at once. You can invite them again later.`}
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <Button type="button" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" autoFocus>
                {confirm.kind === 'transfer' ? 'Transfer ownership' : target.isSelf ? 'Leave store' : 'Remove member'}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
