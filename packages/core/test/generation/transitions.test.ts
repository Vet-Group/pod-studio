import { describe, expect, it } from 'vitest';
import contract from '../../../contracts/schemas/common.schema.json';
import { auditLog, eq, generationJobs, providerAccounts, storeMembers } from '@pod-studio/db';
import { claimJob } from '../../src/generation/scheduler';
import { cancelJob, completeJob, createJob, failJob, heartbeatJob } from '../../src/generation/transitions';
import { ERROR_CLASSES, requesterFailureMessage } from '../../src/generation/error-classes';
import { A, harness, jobs, now, other, owner } from './harness';

async function running() {
  const h = await harness();
  await jobs(h.db, 1);
  const job = (await claimJob(h.db, h, now))!;
  return { ...h, job, lease: { jobId: job.id, leaseToken: job.leaseToken! } };
}

describe('generation transitions', () => {
  const cases = [
    ['account_rate_limited', 'queued', 'cooldown', 0],
    ['account_session_expired', 'queued', 'session_expired', 0],
    ['account_unavailable', 'queued', 'cooldown', 0],
    ['provider_refused', 'failed', 'available', 1],
    ['input_invalid', 'failed', 'available', 1],
    ['transient', 'queued', 'available', 1],
    ['cancelled', 'cancelled', 'available', 0],
  ] as const;
  it('error classes match the complete worker contract', () => {
    expect(Object.keys(ERROR_CLASSES).sort()).toEqual(contract.$defs.ErrorClass.enum.slice().sort());
  });
  it.each(cases)('%s determines job/account states and attempt counting', async (errorClass, status, state, attempt) => {
    const { db, job, lease, accountId } = await running();
    if (errorClass === 'cancelled') await cancelJob(db, owner, job.id, now);
    const result = await failJob(db, { ...lease, errorClass, retryAfterSeconds: 120, message: '  Provider detail\u0000\u0007  ' }, now);
    expect(result).toMatchObject({ status, attempt, errorClass, leaseToken: null, leaseExpiresAt: null });
    expect(result.workerMessage).toBe('Provider detail');
    expect(requesterFailureMessage(result)).toBe(errorClass === 'provider_refused' || errorClass === 'input_invalid' ? 'Provider detail' : null);
    const [account] = await db.select().from(providerAccounts).where(eq(providerAccounts.id, accountId));
    expect(account?.state).toBe(state);
    if (state === 'cooldown') expect(account?.cooldownUntil).toEqual(new Date(now.getTime() + 120_000));
    if (errorClass === 'transient') expect(result.availableAt.getTime()).toBeGreaterThan(now.getTime());
    if (errorClass.startsWith('account_')) expect(result.accountRequeues).toBe(1);
  });

  it('two racing completions yield exactly one winner', async () => {
    const { db, lease } = await running();
    const result = await Promise.allSettled([completeJob(db, lease, now), completeJob(db, lease, now)]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(result.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'job_not_active' } });
  });
  it('a racing complete and fail cannot both win or mutate the account after losing', async () => {
    const { db, lease, accountId } = await running();
    const result = await Promise.allSettled([completeJob(db, lease, now), failJob(db, { ...lease, errorClass: 'account_session_expired', message: 'Session expired.' }, now)]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, lease.jobId));
    const [account] = await db.select().from(providerAccounts).where(eq(providerAccounts.id, accountId));
    expect(account?.state).toBe(job?.status === 'completed' ? 'available' : 'session_expired');
  });
  it('cancellation recorded first wins over completion and is audited once', async () => {
    const { db, job, lease } = await running();
    await cancelJob(db, owner, job.id, now);
    await expect(completeJob(db, lease, now)).rejects.toMatchObject({ code: 'job_not_active' });
    await expect(cancelJob(db, owner, job.id, now)).rejects.toMatchObject({ code: 'job_not_active' });
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'generation_job.cancel'))).toHaveLength(1);
    expect((await failJob(db, { ...lease, errorClass: 'cancelled', message: 'Cancellation acknowledged.' }, now)).status).toBe('cancelled');
  });
  it('requires cancellation before a worker can report cancelled', async () => {
    const { db, lease } = await running();
    await expect(failJob(db, { ...lease, errorClass: 'cancelled', message: 'Cancellation acknowledged.' }, now)).rejects.toMatchObject({ code: 'job_not_active' });
  });
  it.each(['', '   ', '\u0000\u0007', 'x'.repeat(2001)])('rejects invalid worker messages before changing state: %j', async (message) => {
    const { db, lease } = await running();
    await expect(failJob(db, { ...lease, errorClass: 'input_invalid', message }, now)).rejects.toMatchObject({ code: 'validation_failed' });
    const [unchanged] = await db.select().from(generationJobs).where(eq(generationJobs.id, lease.jobId));
    expect(unchanged?.status).toBe('running');
    expect(unchanged?.workerMessage).toBeNull();
  });
  it('requires a message at the runtime boundary and preserves plain untrusted text', async () => {
    const { db, lease } = await running();
    await expect(failJob(db, { ...lease, errorClass: 'input_invalid', message: undefined as unknown as string }, now))
      .rejects.toMatchObject({ code: 'validation_failed' });
    const result = await failJob(db, { ...lease, errorClass: 'input_invalid', message: '  <script>alert("prompt")</script>\u0085  ' }, now);
    expect(requesterFailureMessage(result)).toBe('<script>alert("prompt")</script>');
    const audits = await db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('generation_job.fail');
    expect(JSON.stringify(audits)).not.toContain(result.workerMessage);
  });
  it('accepts the 2000-character trimmed limit without auditing worker messages', async () => {
    const { db, lease } = await running();
    const result = await failJob(db, { ...lease, errorClass: 'provider_refused', message: `  ${'x'.repeat(2000)}  ` }, now);
    expect(result.workerMessage).toBe('x'.repeat(2000));
    expect(requesterFailureMessage(result)).toBe('x'.repeat(2000));
    const audits = await db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('generation_job.fail');
    expect(JSON.stringify(audits)).not.toContain(result.workerMessage);
  });
  it('wrong token and expired lease cannot complete, fail or heartbeat', async () => {
    const { db, lease } = await running();
    const wrong = { ...lease, leaseToken: 'stale-token' };
    for (const request of [wrong, lease]) {
      const time = request === lease ? new Date(now.getTime() + 180_000) : now;
      await expect(completeJob(db, request, time)).rejects.toMatchObject({ code: 'lease_lost' });
      await expect(failJob(db, { ...request, errorClass: 'transient', message: 'Temporary provider error.' }, time)).rejects.toMatchObject({ code: 'lease_lost' });
      await expect(heartbeatJob(db, request, time)).rejects.toMatchObject({ code: 'lease_lost' });
    }
  });
  it('heartbeat extends a live lease and reports cancellation without overriding it', async () => {
    const { db, lease, job } = await running();
    const later = new Date(now.getTime() + 45_000);
    expect((await heartbeatJob(db, lease, later)).leaseExpiresAt).toEqual(new Date(later.getTime() + 180_000));
    await cancelJob(db, owner, job.id, later);
    expect((await heartbeatJob(db, lease, later)).cancelRequested).toBe(true);
  });
  it('transient retries stop at maxAttempts and account retries stop after N requeues', async () => {
    const first = await running();
    await first.db.update(generationJobs).set({ attempt: 2 }).where(eq(generationJobs.id, first.job.id));
    expect(await failJob(first.db, { ...first.lease, errorClass: 'transient', message: 'Temporary provider error.' }, now)).toMatchObject({ status: 'failed', attempt: 3 });
    const second = await running();
    await second.db.update(generationJobs).set({ accountRequeues: 2 }).where(eq(generationJobs.id, second.job.id));
    expect(await failJob(second.db, { ...second.lease, errorClass: 'account_unavailable', message: 'Provider unavailable.' }, now, { maxAccountRequeues: 2 })).toMatchObject({ status: 'failed', attempt: 0, failureReason: 'no healthy account available' });
  });
  it('creation and queued cancellation check store permissions and write secret-free audit rows', async () => {
    const { db } = await harness();
    const job = await createJob(db, owner, { storeId: A, type: 'generate', provider: 'chatgpt' }, now);
    expect(job).toMatchObject({ requesterId: owner.userId, status: 'queued', priority: 'normal' });
    await expect(cancelJob(db, other, job.id, now)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await cancelJob(db, owner, job.id, now)).status).toBe('cancelled');
    const audit = await db.select().from(auditLog);
    expect(audit.map((a) => a.action).sort()).toEqual(['generation_job.cancel', 'generation_job.create']);
    for (const row of audit) expect(row.data).toEqual({});
    await db.update(storeMembers).set({ permissions: ['store.view'] }).where(eq(storeMembers.userId, owner.userId));
    await expect(createJob(db, owner, { storeId: A, type: 'generate', provider: 'chatgpt' }, now)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(createJob(db, { userId: other.userId, role: 'admin' }, { storeId: 'missing-store', type: 'generate', provider: 'chatgpt' }, now)).rejects.toMatchObject({ code: 'validation_failed' });
  });
  it('a reclaimed job rejects its old lease and accepts only the fresh token', async () => {
    const { db, lease, job, accountId, workerId } = await running();
    await failJob(db, { ...lease, errorClass: 'transient', message: 'Temporary provider error.' }, now);
    const later = new Date(now.getTime() + 10_000);
    const reclaimed = (await claimJob(db, { accountId, workerId }, later))!;
    expect(reclaimed.id).toBe(job.id);
    expect(reclaimed.leaseToken).not.toBe(lease.leaseToken);
    await expect(completeJob(db, lease, later)).rejects.toMatchObject({ code: 'lease_lost' });
    expect((await completeJob(db, { jobId: job.id, leaseToken: reclaimed.leaseToken! }, later)).status).toBe('completed');
  });
  it('validates open provider keys, job kinds, priorities and retry limits before inserts', async () => {
    const { db } = await harness();
    await expect(createJob(db, owner, { storeId: A, type: 'generate', provider: 'INVALID' }, now)).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(createJob(db, owner, { storeId: A, type: 'generate', provider: 'chatgpt', maxAttempts: 0 }, now)).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await db.select().from(generationJobs)).toHaveLength(0);
  });
});
