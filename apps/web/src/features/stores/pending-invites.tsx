'use client';

import { useState, useTransition } from 'react';
import { FormAlert } from '@/components/auth/field';
import { Button } from '@/components/ui/button';
import { revokeInviteAction } from '@/features/stores/actions';
import type { InviteView } from '@/features/stores/types';
import { useHydrated } from '@/lib/use-hydrated';

/** "Pending invites" panel: `.listrow` per invite, with revoke for whoever may manage members. */
export function PendingInvites({ storeId, invites }: { storeId: string; invites: InviteView[] }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const hydrated = useHydrated();
  const [, startTransition] = useTransition();

  return (
    <section aria-labelledby="pending-invites" className="bg-paper border-line rounded-card min-w-0 border p-[22px] max-md:p-[18px]">
      <h2 id="pending-invites" className="text-[15px] leading-[1.4] font-bold">
        Pending invites
      </h2>
      <FormAlert message={error} />
      {invites.length === 0 ? (
        <p className="text-muted mt-3 text-[12.5px]">No pending invites. Invite a member to send a link.</p>
      ) : (
        <ul>
          {invites.map((invite) => (
            <li key={invite.id} className="border-line flex items-center gap-3.5 border-b py-[18px] last:border-b-0 max-md:flex-wrap">
              <span
                aria-hidden="true"
                className="inline-grid size-8 shrink-0 place-items-center rounded-full bg-[#dcc8b6] text-[12.5px] font-bold text-[#5a4a3a]"
              >
                @
              </span>
              {/* On phones the address keeps the row beside the avatar; badge and Revoke wrap below. */}
              <div className="min-w-0 flex-1 max-md:min-w-[calc(100%-46px)]">
                <b className="block text-[13px] [overflow-wrap:anywhere]">{invite.email}</b>
                <p className="text-muted mt-[5px] text-[12.5px]">
                  {invite.roleLabel} · expires {invite.expires}
                </p>
              </div>
              <span className="inline-flex items-center rounded-[4px] bg-[#f6ead1] px-[7px] py-[3px] text-[11.5px] font-semibold whitespace-nowrap text-[#7a5626]">
                Awaiting acceptance
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="text-[#a94737]"
                aria-label={`Revoke invite for ${invite.email}`}
                disabled={!hydrated || busy !== null}
                onClick={() => {
                  setError(null);
                  setBusy(invite.id);
                  startTransition(async () => {
                    try {
                      const result = await revokeInviteAction(storeId, invite.id);
                      if (result?.ok === false) setError(result.error);
                    } catch {
                      setError('Something went wrong. Reload the page and try again.');
                    } finally {
                      setBusy(null);
                    }
                  });
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
