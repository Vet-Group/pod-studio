import { and, eq, generationJobs, lte, or, sql, type Database } from '@pod-studio/db';
import { accountRetryLimit, failureUpdate, GenerationError, type RetryOptions } from '@pod-studio/core';

export interface ReaperOptions extends RetryOptions { batchSize?: number }

/** One bounded sweep. A future pg-boss schedule can call this without owning AI jobs. */
export async function reapExpiredLeases(db: Database, now = new Date(), opts: ReaperOptions = {}): Promise<number> {
  const batchSize = opts.batchSize ?? 100;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new GenerationError('validation_failed');
  const limit = accountRetryLimit(opts);
  return db.transaction(async (tx) => {
    const expired = await tx.select().from(generationJobs).where(or(
      and(eq(generationJobs.status, 'running'), lte(generationJobs.leaseExpiresAt, now)),
      and(eq(generationJobs.status, 'queued'), sql`${generationJobs.accountRequeues} > ${limit}`),
    )).orderBy(generationJobs.leaseExpiresAt, generationJobs.createdAt, generationJobs.id).limit(batchSize).for('update', { skipLocked: true });
    let reaped = 0;
    for (const job of expired) {
      const update = job.status === 'queued'
        ? { status: 'failed' as const, failureReason: 'no healthy account available', finishedAt: now, updatedAt: now }
        : failureUpdate(job, job.cancelRequested ? 'cancelled' : 'transient', now, opts);
      const won = await tx.update(generationJobs).set(update).where(and(
        eq(generationJobs.id, job.id), eq(generationJobs.status, job.status),
        sql`${generationJobs.leaseToken} is not distinct from ${job.leaseToken}::text`,
        job.status === 'running' ? lte(generationJobs.leaseExpiresAt, now) : sql`${generationJobs.accountRequeues} > ${limit}`,
      )).returning({ id: generationJobs.id });
      reaped += won.length;
    }
    return reaped;
  });
}
