import { and, eq, generationJobs, generationRequesterTurns, generationStoreTurns, isNull, lte, newId, providerAccounts, sql, workers, type Database } from '@pod-studio/db';

import type { Executor } from '../audit/log';

export const LEASE_SECONDS = 180;
export const HEARTBEAT_INTERVAL_SECONDS = 45;
export const MAX_CLAIM_WAIT_SECONDS = 25;
export interface ClaimRequest { accountId: string; workerId: string; jobTypes?: string[] }

/** Shared with the query-plan regression test to measure the production candidate query. */
export function claimCandidateQuery(db: Executor, account: typeof providerAccounts.$inferSelect, now: Date, requestedTypes?: string[]) {
  const allowedTypes = requestedTypes?.length ? requestedTypes.filter((type) => account.jobTypes.includes(type as typeof account.jobTypes[number])) : account.jobTypes;
  return db.select({ job: generationJobs }).from(generationJobs)
    .leftJoin(generationStoreTurns, and(eq(generationStoreTurns.priority, generationJobs.priority), eq(generationStoreTurns.storeId, generationJobs.storeId)))
    .leftJoin(generationRequesterTurns, and(eq(generationRequesterTurns.priority, generationJobs.priority), eq(generationRequesterTurns.storeId, generationJobs.storeId), eq(generationRequesterTurns.requesterId, generationJobs.requesterId)))
    .where(and(
      // Literal predicates let PostgreSQL use the partial index even with a cached generic plan.
      sql`${generationJobs.status} = 'queued' and ${generationJobs.leaseToken} is null and ${generationJobs.cancelRequested} = false`,
      eq(generationJobs.provider, account.provider), lte(generationJobs.availableAt, now),
      sql`${generationJobs.type} in (select jsonb_array_elements_text(${JSON.stringify(allowedTypes)}::jsonb))`,
      sql`not exists (
        select 1 from jsonb_array_elements(${generationJobs.requiredProviderSkills}) required
        where not exists (
          select 1 from jsonb_array_elements(${JSON.stringify(account.installedSkills)}::jsonb) installed
          where installed->>'slug' = required->>'slug'
            and (required->>'version' is null or installed->>'version' = required->>'version')
        )
      )`,
    )).orderBy(
      sql`case ${generationJobs.priority} when 'interactive' then 0 when 'normal' then 1 else 2 end`,
      sql`coalesce(${generationStoreTurns.lastDispatch}, 0)`,
      sql`coalesce(${generationRequesterTurns.lastDispatch}, 0)`,
      generationJobs.createdAt, generationJobs.id,
    ).limit(1).for('update', { of: generationJobs, skipLocked: true });
}

/** A claim is a short transaction; no provider work or HTTP wait takes place inside it. */
export async function claimJob(db: Database, request: ClaimRequest, now = new Date()) {
  return db.transaction(async (tx) => {
    const [account] = await tx.select().from(providerAccounts)
      .where(and(eq(providerAccounts.id, request.accountId), eq(providerAccounts.workerId, request.workerId))).for('update');
    const [worker] = await tx.select().from(workers).where(eq(workers.id, request.workerId));
    if (!account || worker?.state !== 'active') return null;
    if (account.state !== 'available' && account.state !== 'cooldown') return null;
    if (account.cooldownUntil && account.cooldownUntil > now) return null;
    if (account.state === 'cooldown' && !account.cooldownUntil) return null;
    if (account.sessionExpiresAt && account.sessionExpiresAt <= now) return null;
    if (!Number.isInteger(account.maxConcurrency) || account.maxConcurrency < 1) return null;
    const [activity] = await tx.select({ active: sql<number>`count(*)::int` }).from(generationJobs)
      .where(and(eq(generationJobs.accountId, account.id), sql`${generationJobs.status} = 'running'`));
    if ((activity?.active ?? 0) >= account.maxConcurrency) return null;

    // Serialize just turn allocation, so concurrent accounts observe the previous store/requester
    // turn. Row locks still SKIP LOCKED jobs busy with completion, cancellation or the reaper.
    await tx.execute(sql`select pg_advisory_xact_lock(706, 1)`);
    const [candidate] = await claimCandidateQuery(tx, account, now, request.jobTypes);
    if (!candidate) return null;
    const job = candidate.job;
    const [turn] = await tx.execute<{ next: string }>(sql`select nextval('generation_dispatch_order_seq')::text as next`);
    const [claimed] = await tx.update(generationJobs).set({
      status: 'running', accountId: account.id, workerId: worker.id,
      leaseToken: newId(), leaseExpiresAt: new Date(now.getTime() + LEASE_SECONDS * 1000),
      dispatchOrder: BigInt(turn!.next), updatedAt: now,
    }).where(and(eq(generationJobs.id, job.id), eq(generationJobs.status, 'queued'), isNull(generationJobs.leaseToken))).returning();
    if (!claimed) throw new Error('Locked generation candidate changed unexpectedly.');
    await tx.insert(generationStoreTurns).values({ priority: job.priority, storeId: job.storeId, lastDispatch: claimed.dispatchOrder })
      .onConflictDoUpdate({ target: [generationStoreTurns.priority, generationStoreTurns.storeId], set: { lastDispatch: claimed.dispatchOrder } });
    await tx.insert(generationRequesterTurns).values({ priority: job.priority, storeId: job.storeId, requesterId: job.requesterId, lastDispatch: claimed.dispatchOrder })
      .onConflictDoUpdate({ target: [generationRequesterTurns.priority, generationRequesterTurns.storeId, generationRequesterTurns.requesterId], set: { lastDispatch: claimed.dispatchOrder } });
    await tx.update(providerAccounts).set({ state: 'available', cooldownUntil: null, lastHealthyAt: now, updatedAt: now })
      .where(eq(providerAccounts.id, account.id));
    return claimed ?? null;
  });
}
