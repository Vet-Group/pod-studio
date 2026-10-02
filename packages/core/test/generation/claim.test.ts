import { describe, expect, it } from 'vitest';
import { and, eq, generationJobs, newId, providerAccounts, sql, stores, workers } from '@pod-studio/db';
import { claimJob, LEASE_SECONDS } from '../../src/generation/scheduler';
import { A, B, account, harness, jobs, now, other } from './harness';

describe('generation scheduler', () => {
  it('50 parallel claims on 20 jobs never double-claim', async () => {
    const { db, workerId } = await harness();
    await jobs(db, 20);
    const accounts = await Promise.all(Array.from({ length: 50 }, () => account(db, workerId)));
    const results = await Promise.all(accounts.map((accountId) => claimJob(db, { accountId, workerId }, now)));
    const claimed = results.filter((r) => r !== null);
    expect(claimed).toHaveLength(20);
    expect(new Set(claimed.map((r) => r.id)).size).toBe(20);
    expect(new Set(claimed.map((r) => r.leaseToken)).size).toBe(20);
    for (const job of claimed) expect(job.leaseExpiresAt).toEqual(new Date(now.getTime() + LEASE_SECONDS * 1000));
    expect(await db.select().from(generationJobs).where(eq(generationJobs.status, 'running'))).toHaveLength(20);
  });

  it('preserves tier, store and requester turns across concurrent workers with skewed queues', async () => {
    const { db } = await harness();
    const C = 'store_ccc';
    await db.insert(stores).values({ id: C, name: C, domain: `${C}.myshopify.com` });
    await jobs(db, 200);
    await jobs(db, 2, { storeId: B });
    await jobs(db, 1, { storeId: C });
    await jobs(db, 1, { storeId: C, requesterId: other.userId });
    await jobs(db, 2, { priority: 'interactive', storeId: C, requesterId: other.userId });
    await jobs(db, 2, { priority: 'bulk', storeId: B });
    const claims = await Promise.all(Array.from({ length: 8 }, async () => {
      const workerId = newId();
      await db.insert(workers).values({ id: workerId, workerKey: workerId, host: 'test', version: 'test' });
      const accountId = await account(db, workerId);
      return claimJob(db, { accountId, workerId }, now);
    }));
    expect(claims.every((job) => job !== null)).toBe(true);
    const ordered = claims.filter((job) => job !== null).sort((a, b) => a.dispatchOrder! < b.dispatchOrder! ? -1 : 1);
    expect(new Set(ordered.map((job) => job.id)).size).toBe(8);
    expect(new Set(ordered.map((job) => job.leaseToken)).size).toBe(8);
    expect(new Set(ordered.map((job) => job.workerId)).size).toBe(8);
    expect(ordered.map((job) => job.priority)).toEqual(['interactive', 'interactive', ...Array<string>(6).fill('normal')]);
    expect(ordered.slice(2).map((job) => job.storeId)).toEqual([A, B, C, A, B, C]);
    expect(ordered.slice(2).filter((job) => job.storeId === C).map((job) => job.requesterId)).toEqual(['requester_owner', other.userId]);
  });

  it('allocates exact bigint dispatch orders beyond the JavaScript safe integer bound', async () => {
    const { db, accountId, workerId } = await harness();
    await jobs(db, 2);
    await db.execute(sql`select setval('generation_dispatch_order_seq', 9007199254740992, true)`);
    const first = await claimJob(db, { accountId, workerId }, now);
    const second = await claimJob(db, { accountId, workerId }, now);
    expect(first?.dispatchOrder).toBe(9007199254740993n);
    expect(second?.dispatchOrder).toBe(9007199254740994n);
  });

  it('gives B a turn in each of the first two rounds despite 200 older A jobs', async () => {
    const { db, accountId, workerId } = await harness();
    await jobs(db, 200);
    const small = await jobs(db, 2, { storeId: B });
    const claimed = [];
    for (let i = 0; i < 4; i++) claimed.push(await claimJob(db, { accountId, workerId }, now));
    expect(claimed.map((j) => j?.storeId)).toEqual([A, B, A, B]);
    expect(claimed.filter((j) => j?.storeId === B).map((j) => j?.id)).toEqual(small.map((j) => j.id));
  });

  it('round-robins requesters within a store before choosing oldest job', async () => {
    const { db, accountId, workerId } = await harness();
    await jobs(db, 20);
    await jobs(db, 2, { requesterId: other.userId });
    const claimed = [];
    for (let i = 0; i < 4; i++) claimed.push(await claimJob(db, { accountId, workerId }, now));
    expect(claimed.map((j) => j?.requesterId)).toEqual(['requester_owner', other.userId, 'requester_owner', other.userId]);
  });

  it('retains turns when a claimed job is requeued or completed history is deleted', async () => {
    const { db, accountId, workerId } = await harness();
    await jobs(db, 10);
    await jobs(db, 2, { storeId: B });
    const first = await claimJob(db, { accountId, workerId }, now);
    expect(first?.storeId).toBe(A);
    await db.update(generationJobs).set({ status: 'queued', leaseToken: null, leaseExpiresAt: null }).where(eq(generationJobs.id, first!.id));
    expect((await claimJob(db, { accountId, workerId }, now))?.storeId).toBe(B);
    const third = await claimJob(db, { accountId, workerId }, now);
    expect(third?.storeId).toBe(A);
    await db.update(generationJobs).set({ status: 'completed' }).where(eq(generationJobs.id, third!.id));
    await db.delete(generationJobs).where(eq(generationJobs.id, third!.id));
    expect((await claimJob(db, { accountId, workerId }, now))?.storeId).toBe(B);
  });

  it('honors interactive, normal, bulk tiers ahead of fairness and age', async () => {
    const { db, accountId, workerId } = await harness();
    await jobs(db, 1, { priority: 'bulk' });
    await jobs(db, 1, { priority: 'normal' });
    await jobs(db, 1, { priority: 'interactive', storeId: B });
    const claimed = [];
    for (let i = 0; i < 3; i++) claimed.push(await claimJob(db, { accountId, workerId }, now));
    expect(claimed.map((j) => j?.priority)).toEqual(['interactive', 'normal', 'bulk']);
  });

  it('matches provider, job type and every required skill including version', async () => {
    const { db, accountId, workerId } = await harness();
    await jobs(db, 1, { provider: 'grok' });
    await jobs(db, 1, { type: 'analyze' });
    await jobs(db, 1, { requiredProviderSkills: [{ slug: 'render-image', version: '2.0.0' }] });
    await jobs(db, 1, { requiredProviderSkills: [{ slug: 'render-image' }, { slug: 'other-skill' }] });
    expect(await claimJob(db, { accountId, workerId }, now)).toBeNull();
    await db.update(providerAccounts).set({ installedSkills: [{ slug: 'render-image', version: '1.0.0' }] }).where(eq(providerAccounts.id, accountId));
    expect(await claimJob(db, { accountId, workerId }, now)).toBeNull();
    await db.update(providerAccounts).set({ installedSkills: [{ slug: 'render-image', version: '2.0.0' }] }).where(eq(providerAccounts.id, accountId));
    expect((await claimJob(db, { accountId, workerId }, now))?.requiredProviderSkills).toEqual([{ slug: 'render-image', version: '2.0.0' }]);
  });

  it.each([
    { state: 'cooldown' as const, cooldownUntil: new Date(now.getTime() + 60_000) },
    { sessionExpiresAt: now },
    { state: 'session_expired' as const },
    { state: 'disabled' as const },
  ])('refuses unhealthy account %j', async (overrides) => {
    const { db, workerId } = await harness();
    const accountId = await account(db, workerId, overrides);
    await jobs(db, 1);
    expect(await claimJob(db, { accountId, workerId }, now)).toBeNull();
  });

  it('restores rotation after cooldown and rejects mismatched or disabled workers', async () => {
    const { db, accountId, workerId } = await harness();
    await jobs(db, 1);
    await db.update(providerAccounts).set({ state: 'cooldown', cooldownUntil: now }).where(eq(providerAccounts.id, accountId));
    expect(await claimJob(db, { accountId, workerId: 'wrong-worker' }, now)).toBeNull();
    await db.update(workers).set({ state: 'disabled' }).where(eq(workers.id, workerId));
    expect(await claimJob(db, { accountId, workerId }, now)).toBeNull();
    await db.update(workers).set({ state: 'active' }).where(eq(workers.id, workerId));
    expect(await claimJob(db, { accountId, workerId }, now)).not.toBeNull();
  });

  it('enforces account concurrency even with parallel claims', async () => {
    const { db, accountId, workerId } = await harness();
    await jobs(db, 5);
    await db.update(providerAccounts).set({ maxConcurrency: 1 }).where(eq(providerAccounts.id, accountId));
    const claimed = await Promise.all(Array.from({ length: 10 }, () => claimJob(db, { accountId, workerId }, now)));
    expect(claimed.filter(Boolean)).toHaveLength(1);
  });

  it('never claims a malformed queued row that still carries a lease token', async () => {
    const { db, accountId, workerId } = await harness();
    await jobs(db, 1, { leaseToken: 'stale-token' });
    expect(await claimJob(db, { accountId, workerId }, now)).toBeNull();
  });

  it('skips a job locked by a separate transaction', async () => {
    const { db, accountId, workerId } = await harness();
    const queued = await jobs(db, 2);
    await db.transaction(async (tx) => {
      await tx.execute(sql`select id from generation_jobs where id = ${queued[0]!.id} for update`);
      expect((await claimJob(db, { accountId, workerId }, now))?.id).toBe(queued[1]!.id);
    });
    expect(await db.select().from(generationJobs).where(and(eq(generationJobs.id, queued[0]!.id), eq(generationJobs.status, 'queued')))).toHaveLength(1);
  });
});
