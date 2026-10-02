import { describe, expect, it } from 'vitest';
import { eq, generationJobs } from '@pod-studio/db';
import { claimJob } from '@pod-studio/core';
import { cancelJob, completeJob } from '@pod-studio/core';
import { harness, jobs, now, owner } from '../../../packages/core/test/generation/harness';
import { reapExpiredLeases } from '../src/reapers/lease-reaper';

async function expired(overrides: Partial<typeof generationJobs.$inferInsert> = {}) {
  const h = await harness();
  await jobs(h.db, 1, overrides);
  const job = (await claimJob(h.db, h, now))!;
  return { ...h, job, later: new Date(now.getTime() + 180_000) };
}
describe('lease reaper', () => {
  it('returns an expired lease to queued and counts one transient attempt, once only', async () => {
    const { db, job, later } = await expired();
    expect(await reapExpiredLeases(db, later)).toBe(1);
    expect(await reapExpiredLeases(db, later)).toBe(0);
    const [row] = await db.select().from(generationJobs).where(eq(generationJobs.id, job.id));
    expect(row).toMatchObject({ status: 'queued', attempt: 1, errorClass: 'transient', leaseToken: null, leaseExpiresAt: null });
    expect(row!.availableAt.getTime()).toBeGreaterThan(later.getTime());
  });
  it('fails when maxAttempts is exhausted', async () => {
    const { db, later } = await expired({ attempt: 2, maxAttempts: 3 });
    await reapExpiredLeases(db, later);
    expect((await db.select().from(generationJobs))[0]).toMatchObject({ status: 'failed', attempt: 3 });
  });
  it('fails an account-error loop with no healthy account available', async () => {
    const { db } = await harness();
    await jobs(db, 1, { accountRequeues: 3, errorClass: 'account_unavailable' });
    expect(await reapExpiredLeases(db, now, { maxAccountRequeues: 2 })).toBe(1);
    expect((await db.select().from(generationJobs))[0]).toMatchObject({ status: 'failed', attempt: 0, failureReason: 'no healthy account available' });
  });
  it('two racing reapers count only one attempt', async () => {
    const { db, later } = await expired();
    const counts = await Promise.all([reapExpiredLeases(db, later), reapExpiredLeases(db, later)]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect((await db.select().from(generationJobs))[0]?.attempt).toBe(1);
  });
  it('ignores live and completed leases', async () => {
    const { db, job, later } = await expired();
    expect(await reapExpiredLeases(db, now)).toBe(0);
    await completeJob(db, { jobId: job.id, leaseToken: job.leaseToken! }, now);
    expect(await reapExpiredLeases(db, later)).toBe(0);
  });
  it('honors a recorded cancellation instead of retrying it', async () => {
    const { db, job, later } = await expired({ accountRequeues: 99 });
    await cancelJob(db, owner, job.id, now);
    expect(await reapExpiredLeases(db, later)).toBe(1);
    expect((await db.select().from(generationJobs))[0]).toMatchObject({ status: 'cancelled', attempt: 0 });
  });
  it('bounds each sweep', async () => {
    const h = await harness();
    await jobs(h.db, 2);
    await claimJob(h.db, h, now);
    await claimJob(h.db, h, now);
    const later = new Date(now.getTime() + 180_000);
    expect(await reapExpiredLeases(h.db, later, { batchSize: 1 })).toBe(1);
    expect(await reapExpiredLeases(h.db, later, { batchSize: 1 })).toBe(1);
  });
});
