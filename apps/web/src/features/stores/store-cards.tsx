import Link from 'next/link';
import { STORE_ROLE_LABELS, type StoreSummary } from '@pod-studio/core';
import { cn } from '@/lib/utils';

/** `.storecards` / `.storecard` from the wireframe; each card opens that store's members. */
function viewerRole(store: StoreSummary): string {
  return store.myRole ? `You: ${STORE_ROLE_LABELS[store.myRole]}` : 'You: admin access';
}

export function StoreCards({ stores, currentId }: { stores: StoreSummary[]; currentId?: string }) {
  return (
    <ul className="mb-6 grid grid-cols-3 gap-4 max-lg:gap-2.5 max-md:grid-cols-1">
      {stores.map((store) => {
        const current = store.id === currentId;
        return (
          <li key={store.id} className="min-w-0">
            <Link
              href={`/stores/${store.id}/members`}
              aria-current={current ? 'page' : undefined}
              className={cn(
                'border-line bg-paper hover:bg-soft block h-full rounded-[7px] border p-5 transition-colors max-lg:p-3.5',
                'max-md:grid max-md:grid-cols-[36px_1fr] max-md:gap-x-3',
                current && 'border-teal bg-soft',
              )}
            >
              <span
                aria-hidden="true"
                className="inline-grid size-[34px] place-items-center rounded-lg bg-[#dbe6d5] font-serif text-[21px] text-[#42614a] max-md:row-span-3"
              >
                {store.name.trim()[0]?.toUpperCase() ?? '?'}
              </span>
              <h2 className="mt-3 mb-[3px] text-[15px] leading-[1.4] font-bold [overflow-wrap:anywhere] max-md:m-0">
                {store.name}
              </h2>
              <p className="text-muted text-[12.5px] [overflow-wrap:anywhere]">
                Store owner: {store.owner?.name ?? 'None'}
              </p>
              <p className="text-muted mt-2.5 text-[12.5px]">
                <span aria-hidden="true" className="mr-1.5 inline-block size-[7px] rounded-full bg-[#659175]" />
                {store.memberCount} {store.memberCount === 1 ? 'member' : 'members'} · {viewerRole(store)}
              </p>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
