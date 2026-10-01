import { and, assets, designs, eq, generationJobs, gt, providerAccounts, sql, stores, type Database, type ErrorClass, type JobPriority, type JobType, type ProviderSkill } from '@pod-studio/db';
import { assertCan, type Principal } from '../access/can';
import { AuthError } from '../auth/errors';
import { writeAudit, type Executor } from '../audit/log';
import { ERROR_CLASSES, GenerationError, failureUpdate, sanitizeWorkerMessage, type RetryOptions } from './error-classes';
import { LEASE_SECONDS } from './scheduler';

export interface LeaseRequest { jobId: string; leaseToken: string }
export interface CreateJobInput {
  storeId: string;
  type: JobType;
  provider: string;
  priority?: JobPriority;
  requiredProviderSkills?: ProviderSkill[];
  maxAttempts?: number;
  designId?: string;
  assetId?: string;
}
function permission(type: JobType) { return type === 'analyze' ? 'analysis.run' as const : 'content.generate' as const; }
function validateInput(input: CreateJobInput) {
  if (!['analyze', 'generate', 'redesign', 'seo'].includes(input.type) || !/^[a-z][a-z0-9_]{1,31}$/.test(input.provider)
    || !['interactive', 'normal', 'bulk'].includes(input.priority ?? 'normal')
    || !Number.isInteger(input.maxAttempts ?? 3) || (input.maxAttempts ?? 3) < 1 || (input.maxAttempts ?? 3) > 100
    || (input.requiredProviderSkills ?? []).some((s) => !s || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.slug) || s.slug.length < 2 || s.slug.length > 64
      || (s.version !== undefined && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/.test(s.version)))) {
    throw new GenerationError('validation_failed');
  }
}

/** User creation is permission-checked and audited in the same transaction as the insert. */
export async function createJob(db: Database, principal: Principal, input: CreateJobInput, now = new Date()) {
  validateInput(input);
  return db.transaction(async (tx) => {
    await assertCan(tx, principal, permission(input.type), input.storeId);
    const [store] = await tx.select({ id: stores.id }).from(stores).where(eq(stores.id, input.storeId));
    if (!store) throw new GenerationError('validation_failed');
    // Do not allow a caller to smuggle another store's design or asset into a worker job.
    if (input.designId) {
      const [design] = await tx.select().from(designs).where(and(eq(designs.id, input.designId), eq(designs.storeId, input.storeId)));
      if (!design) throw new GenerationError('validation_failed');
    }
    if (input.assetId) {
      const [asset] = await tx.select().from(assets).where(and(eq(assets.id, input.assetId), eq(assets.storeId, input.storeId)));
      if (!asset) throw new GenerationError('validation_failed');
    }
    const [job] = await tx.insert(generationJobs).values({
      storeId: input.storeId, requesterId: principal.userId, type: input.type, provider: input.provider,
      priority: input.priority ?? 'normal', maxAttempts: input.maxAttempts ?? 3,
      requiredProviderSkills: input.requiredProviderSkills ?? [], designId: input.designId, assetId: input.assetId,
      createdAt: now, updatedAt: now, availableAt: now,
    }).returning();
    await writeAudit(tx, { actorUserId: principal.userId, storeId: input.storeId, action: 'generation_job.create', targetType: 'generation_job', targetId: job!.id });
    return job!;
  });
}

/** Running cancellation records intent. The worker acknowledges it or the reaper finalizes it. */
export async function cancelJob(db: Database, principal: Principal, jobId: string, now = new Date()) {
  return db.transaction(async (tx) => {
    const [job] = await tx.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    if (!job) throw new GenerationError('job_not_active');
    await assertCan(tx, principal, permission(job.type), job.storeId);
    if (job.requesterId !== principal.userId) throw new AuthError('FORBIDDEN');
    const [cancelled] = await tx.update(generationJobs).set({
      cancelRequested: true, status: job.status === 'queued' ? 'cancelled' : 'running',
      finishedAt: job.status === 'queued' ? now : null, updatedAt: now,
    }).where(and(eq(generationJobs.id, job.id), eq(generationJobs.status, job.status),
      sql`${generationJobs.leaseToken} is not distinct from ${job.leaseToken}::text`,
      eq(generationJobs.cancelRequested, false), sql`${generationJobs.status} in ('queued', 'running')`,
    )).returning();
    if (!cancelled) throw new GenerationError('job_not_active');
    await writeAudit(tx, { actorUserId: principal.userId, storeId: job.storeId, action: 'generation_job.cancel', targetType: 'generation_job', targetId: job.id });
    return cancelled;
  });
}

function leaseGuard(request: LeaseRequest, now: Date) {
  return and(eq(generationJobs.id, request.jobId), eq(generationJobs.status, 'running'),
    eq(generationJobs.leaseToken, request.leaseToken), gt(generationJobs.leaseExpiresAt, now));
}
async function lostLease(db: Executor, request: LeaseRequest): Promise<never> {
  const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, request.jobId));
  throw new GenerationError(!job || job.status !== 'running' || job.cancelRequested ? 'job_not_active' : 'lease_lost');
}
export async function completeJob(db: Database, request: LeaseRequest, now = new Date()) {
  const [job] = await db.update(generationJobs).set({ status: 'completed', leaseToken: null, leaseExpiresAt: null, finishedAt: now, updatedAt: now })
    .where(and(leaseGuard(request, now), eq(generationJobs.cancelRequested, false))).returning();
  return job ?? lostLease(db, request);
}
export async function heartbeatJob(db: Database, request: LeaseRequest, now = new Date()) {
  const [job] = await db.update(generationJobs).set({ leaseExpiresAt: new Date(now.getTime() + LEASE_SECONDS * 1000), updatedAt: now })
    .where(leaseGuard(request, now)).returning();
  return job ?? lostLease(db, request);
}
export async function failJob(db: Database, request: LeaseRequest & { errorClass: ErrorClass; message: string; retryAfterSeconds?: number }, now = new Date(), opts: RetryOptions = {}) {
  const workerMessage = sanitizeWorkerMessage(request.message);
  if (!Object.hasOwn(ERROR_CLASSES, request.errorClass) || (request.retryAfterSeconds !== undefined && (!Number.isInteger(request.retryAfterSeconds) || request.retryAfterSeconds < 1 || request.retryAfterSeconds > 86400))) {
    throw new GenerationError('validation_failed');
  }
  return db.transaction(async (tx) => {
    const [snapshot] = await tx.select().from(generationJobs).where(eq(generationJobs.id, request.jobId));
    if (!snapshot) return lostLease(tx, request);
    // Same account-before-job lock order as claim; a losing failure cannot poison an account.
    if (snapshot.accountId) await tx.select().from(providerAccounts).where(eq(providerAccounts.id, snapshot.accountId)).for('update');
    const [current] = await tx.select().from(generationJobs).where(leaseGuard(request, now)).for('update');
    if (!current) return lostLease(tx, request);
    if (current.cancelRequested !== (request.errorClass === 'cancelled')) throw new GenerationError('job_not_active');
    const policy = ERROR_CLASSES[request.errorClass];
    const [job] = await tx.update(generationJobs).set({ ...failureUpdate(current, request.errorClass, now, opts), workerMessage })
      .where(and(leaseGuard(request, now), eq(generationJobs.cancelRequested, request.errorClass === 'cancelled'))).returning();
    if (!job) return lostLease(tx, request);
    if (policy.accountState && current.accountId) {
      const cooldown = 'cooldownSeconds' in policy ? request.retryAfterSeconds ?? policy.cooldownSeconds : null;
      await tx.update(providerAccounts).set({
        state: policy.accountState, cooldownUntil: cooldown ? new Date(now.getTime() + cooldown * 1000) : null,
        ...(policy.accountState === 'session_expired' ? { sessionExpiresAt: now } : {}), updatedAt: now,
      }).where(eq(providerAccounts.id, current.accountId));
    }
    return job;
  });
}
