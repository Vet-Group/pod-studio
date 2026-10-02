import { createHash } from 'node:crypto';
import { and, assets, eq, generationJobs, gt, newId, providerAccounts, sql, skillVersions, workerCleanup, workerResults, workerUploads, workers, type Database, type ErrorClass } from '@pod-studio/db';
import { assertContract, validateContract, type components } from '@pod-studio/contracts';
import { claimJob, HEARTBEAT_INTERVAL_SECONDS, LEASE_SECONDS, MAX_CLAIM_WAIT_SECONDS } from '../generation/scheduler';
import { GenerationError, sanitizeWorkerMessage } from '../generation/error-classes';
import { completeJobWithResults, failJobInTransaction, heartbeatJob } from '../generation/transitions';
import { writeAudit, type Executor } from '../audit/log';
import type { Storage } from '../assets/storage';
import { AssetError } from '../assets/errors';
import { withDurableIdempotency } from './idempotency';

type RegisterRequest = components['schemas']['RegisterRequest'];
type JobType = components['schemas']['JobType'];
type UploadDeclaration = components['schemas']['UploadDeclaration'];
type OutputImage = components['schemas']['OutputImage'];
type CompleteRequest = components['schemas']['CompleteRequest'];
type FailRequest = components['schemas']['FailRequest'];
type AccountStatusRequest = components['schemas']['AccountStatusRequest'];
type ClaimRequest = components['schemas']['ClaimRequest'];
type WorkerRow = typeof workers.$inferSelect;
type UploadRow = typeof workerUploads.$inferSelect;

export class WorkerApiError extends Error {
  constructor(readonly code: string, readonly status: number, message = code, readonly errors?: Array<{ path: string; message: string }>) { super(message); }
}
const JOB_TYPES = ['mockup', 'redesign', 'listing_content', 'product_analysis'] as const;
const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const UPLOAD_CLEANUP_GRACE_MS = 1000;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkerApiError('validation_failed', 400);
  return value as Record<string, unknown>;
};
function assertInput<S extends Parameters<typeof assertContract>[0]>(schema: S, body: unknown): asserts body is unknown {
  const errors = validateContract(schema, body);
  if (errors.length) throw new WorkerApiError('validation_failed', 400, 'The request does not match the worker contract.', errors);
}
function problem(code: string, status: number, detail = code, errors?: Array<{ path: string; message: string }>) {
  return { type: `https://pod-studio.invalid/problems/${code}`, title: code, status, code, detail, ...(errors?.length ? { errors } : {}) };
}
export function apiProblem(error: unknown) {
  const response = error instanceof WorkerApiError
    ? problem(error.code, error.status, error.message, error.errors)
    : error instanceof GenerationError
      ? problem(error.code, 409, error.message)
      : error && typeof error === 'object' && 'contractErrors' in error
        ? problem('validation_failed', 400, 'The request does not match the worker contract.', error.contractErrors as Array<{ path: string; message: string }>)
        : problem('validation_failed', 500, 'An internal error occurred.');
  assertContract('Problem', response);
  return response;
}
function contractType(type: string): JobType {
  if (type === 'generate') return 'mockup';
  if (type === 'seo') return 'listing_content';
  if (type === 'analyze') return 'product_analysis';
  if ((JOB_TYPES as readonly string[]).includes(type)) return type as JobType;
  throw new WorkerApiError('validation_failed', 400);
}
const isJobType = (value: unknown): value is JobType => typeof value === 'string' && (JOB_TYPES as readonly string[]).includes(value);

export function validateRegister(body: unknown): RegisterRequest {
  assertInput('RegisterRequest', body);
  return body as RegisterRequest;
}
export function validateClaim(body: unknown): ClaimRequest {
  assertInput('ClaimRequest', body);
  return body as ClaimRequest;
}
export async function registerWorker(db: Database, worker: WorkerRow, body: unknown, now = new Date()) {
  const input = validateRegister(body);
  if (input.workerKey !== worker.workerKey) throw new WorkerApiError('unauthorized', 401);
  const configuredOrigin = process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT;
  if (!configuredOrigin) throw new WorkerApiError('validation_failed', 500, 'Storage is not configured.');
  let origin: string;
  try {
    const parsed = new URL(configuredOrigin);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error('invalid origin');
    origin = parsed.origin;
  } catch { throw new WorkerApiError('validation_failed', 500, 'Storage is not configured.'); }
  const result = await db.transaction(async (tx) => {
    await tx.update(workers).set({ host: input.host, version: input.version, lastSeenAt: now, updatedAt: now }).where(eq(workers.id, worker.id));
    for (const account of input.accounts) {
      const [existing] = await tx.select().from(providerAccounts).where(and(eq(providerAccounts.workerId, worker.id), eq(providerAccounts.accountKey, account.accountKey))).for('update');
      const cooldownActive = existing?.state === 'cooldown' && existing.cooldownUntil && existing.cooldownUntil > now;
      const state = existing?.state === 'disabled' ? 'disabled' as const : cooldownActive ? 'cooldown' as const : 'available' as const;
      const installedSkills = account.installedSkills ?? existing?.installedSkills ?? [];
      const sessionExpiresAt = existing?.sessionExpiresAt && existing.sessionExpiresAt > now ? existing.sessionExpiresAt : null;
      const values = { workerId: worker.id, accountKey: account.accountKey, provider: account.provider, channel: account.channel, jobTypes: account.jobTypes as typeof providerAccounts.$inferInsert.jobTypes, installedSkills, maxConcurrency: account.maxConcurrency ?? existing?.maxConcurrency ?? 1, state, cooldownUntil: cooldownActive ? existing!.cooldownUntil : null, sessionExpiresAt, lastHealthyAt: now, updatedAt: now };
      if (existing) await tx.update(providerAccounts).set(values).where(eq(providerAccounts.id, existing.id));
      else await tx.insert(providerAccounts).values({ id: newId(), ...values });
    }
    const keys = input.accounts.map((account) => account.accountKey);
    if (keys.length) await tx.update(providerAccounts).set({ state: 'offline', updatedAt: now }).where(and(eq(providerAccounts.workerId, worker.id), sql`${providerAccounts.accountKey} not in (${sql.join(keys.map((key) => sql`${key}`), sql`, `)})`));
    else await tx.update(providerAccounts).set({ state: 'offline', updatedAt: now }).where(eq(providerAccounts.workerId, worker.id));
    await writeAudit(tx, { actorUserId: null, action: 'worker.register', targetType: 'worker', targetId: worker.id, data: { accountCount: input.accounts.length } });
    return tx.select().from(providerAccounts).where(eq(providerAccounts.workerId, worker.id));
  });
  const response = { workerId: worker.id, accounts: result.filter((account) => input.accounts.some((item) => item.accountKey === account.accountKey)).map((account) => ({ accountKey: account.accountKey, accountId: account.id, state: account.state })), heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS, leaseSeconds: LEASE_SECONDS, maxClaimWaitSeconds: MAX_CLAIM_WAIT_SECONDS, storageOrigins: [origin] };
  assertContract('RegisterResponse', response);
  return response;
}

export async function claimWorkerJob(db: Database, storage: Storage, workerId: string, accountId: string, requestedTypes: unknown, now = new Date(), signal?: AbortSignal) {
  if (!ID_RE.test(workerId) || !ID_RE.test(accountId)) throw new WorkerApiError('validation_failed', 400);
  if (signal?.aborted) throw new WorkerApiError('validation_failed', 400, 'Request aborted.');
  const requestTypes = requestedTypes === undefined ? undefined : Array.isArray(requestedTypes) && requestedTypes.every(isJobType) ? requestedTypes : null;
  if (requestTypes === null) throw new WorkerApiError('validation_failed', 400);
  await db.update(workers).set({ lastSeenAt: now, updatedAt: now }).where(eq(workers.id, workerId));
  const [account] = await db.select().from(providerAccounts).where(and(eq(providerAccounts.id, accountId), eq(providerAccounts.workerId, workerId)));
  if (!account || account.state === 'disabled' || account.state === 'offline' || account.state === 'session_expired' || account.state === 'busy' || (account.state === 'cooldown' && !account.cooldownUntil) || (account.cooldownUntil && account.cooldownUntil > now)) throw new WorkerApiError('account_not_claimable', 409);
  const job = await claimJob(db, { accountId, workerId, jobTypes: requestTypes ?? undefined }, now);
  if (!job) {
    await db.update(workers).set({ lastSeenAt: now, updatedAt: now }).where(eq(workers.id, workerId));
    await db.update(providerAccounts).set({
      ...(account.state === 'cooldown' && account.cooldownUntil && account.cooldownUntil <= now ? { state: 'available' as const, cooldownUntil: null } : {}),
      lastHealthyAt: now, updatedAt: now,
    }).where(eq(providerAccounts.id, accountId));
    return null;
  }
  const inputRefs: Array<Record<string, unknown>> = [];
  for (const input of job.inputs ?? []) {
    const assetId = typeof input.assetId === 'string' ? input.assetId : null;
    if (!assetId) continue;
    const [asset] = await db.select().from(assets).where(and(eq(assets.id, assetId), eq(assets.storeId, job.storeId)));
    if (!asset) throw new WorkerApiError('validation_failed', 500, 'A job input asset is unavailable.');
    const signed = await storage.signRead(asset.storageKey, asset.contentType);
    inputRefs.push({ role: typeof input.role === 'string' ? input.role : 'reference', assetId: asset.id, url: signed.url, urlExpiresAt: signed.expiresAt, sha256: asset.sha256, contentType: asset.contentType, bytes: asset.sizeBytes, filename: typeof input.filename === 'string' ? input.filename : asset.id });
  }
  if (job.assetId) {
    const [asset] = await db.select().from(assets).where(and(eq(assets.id, job.assetId), eq(assets.storeId, job.storeId)));
    if (asset) {
      const signed = await storage.signRead(asset.storageKey, asset.contentType);
      inputRefs.push({ role: 'design', assetId: asset.id, url: signed.url, urlExpiresAt: signed.expiresAt, sha256: asset.sha256, contentType: asset.contentType, bytes: asset.sizeBytes, filename: asset.id });
    }
  }
  const response = { job: { id: job.id, type: contractType(job.type), provider: job.provider, attempt: Math.max(1, job.attempt), maxAttempts: job.maxAttempts, leaseToken: job.leaseToken!, leaseExpiresAt: job.leaseExpiresAt!.toISOString(), prompt: job.prompt ?? '', ...(job.systemPrompt ? { systemPrompt: job.systemPrompt } : {}), inputs: inputRefs, ...(job.skill ? { skill: job.skill } : {}), requiredProviderSkills: (job.requiredProviderSkills ?? []).map((skill) => typeof skill === 'string' ? skill : skill.slug), ...(job.timeoutSeconds ? { timeoutSeconds: job.timeoutSeconds } : {}), params: job.params ?? {} } };
  assertContract('ClaimResponse', response);
  return response;
}

function leaseWhere(jobId: string, workerId: string, leaseToken: string, now: Date) {
  return and(eq(generationJobs.id, jobId), eq(generationJobs.workerId, workerId), eq(generationJobs.status, 'running'), eq(generationJobs.leaseToken, leaseToken), gt(generationJobs.leaseExpiresAt, now));
}
function leaseBody(body: unknown): { leaseToken: string } {
  const value = record(body);
  if (typeof value.leaseToken !== 'string') throw new WorkerApiError('validation_failed', 400);
  return { leaseToken: value.leaseToken };
}
export async function heartbeatWorkerJob(db: Database, workerId: string, jobId: string, body: unknown, now = new Date()) {
  assertInput('HeartbeatRequest', body);
  const input = leaseBody(body);
  const [owned] = await db.select({ workerId: generationJobs.workerId, status: generationJobs.status, cancelRequested: generationJobs.cancelRequested }).from(generationJobs).where(and(eq(generationJobs.id, jobId), eq(generationJobs.leaseToken, input.leaseToken)));
  if (!owned || owned.workerId !== workerId || owned.status !== 'running') throw new GenerationError('lease_lost');
  let job;
  try { job = await heartbeatJob(db, { jobId, leaseToken: input.leaseToken }, now); }
  catch (error) { if (error instanceof GenerationError) throw new GenerationError('lease_lost'); throw error; }
  const response = { leaseExpiresAt: job.leaseExpiresAt!.toISOString(), cancelRequested: job.cancelRequested };
  assertContract('HeartbeatResponse', response);
  return response;
}

function uploadDeclarations(body: unknown): { leaseToken: string; files: UploadDeclaration[] } {
  assertInput('UploadsRequest', body);
  const value = body as { leaseToken: string; files: UploadDeclaration[] };
  return value;
}
function validateJobOutput(type: string, input: CompleteRequest): void {
  const normalized = contractType(type);
  if (input.images && !['mockup', 'redesign'].includes(normalized)) throw new WorkerApiError('validation_failed', 400, 'This job requires a JSON payload.');
  if (input.payload && ['mockup', 'redesign'].includes(normalized)) throw new WorkerApiError('validation_failed', 400, 'This job requires uploaded images.');
  if (input.payload) {
    const schema = normalized === 'listing_content' ? 'ListingContentPayload' : 'ProductAnalysisPayload';
    const errors = validateContract(schema, input.payload);
    if (errors.length) throw new WorkerApiError('validation_failed', 400, 'The payload does not match the job output contract.', errors);
  }
}
export async function createWorkerUploads(db: Database, storage: Storage, workerId: string, jobId: string, body: unknown, now = new Date()) {
  const input = uploadDeclarations(body);
  // Validate ownership and cancellation before any signing/network work.
  await db.transaction(async (tx) => {
    const [job] = await tx.select({ id: generationJobs.id, cancelRequested: generationJobs.cancelRequested }).from(generationJobs).where(leaseWhere(jobId, workerId, input.leaseToken, now)).for('update');
    if (!job || job.cancelRequested) throw new GenerationError('lease_lost');
    const [count] = await tx.select({ count: sql<number>`count(*)::int` }).from(workerUploads).where(eq(workerUploads.jobId, jobId));
    if ((count?.count ?? 0) + input.files.length > 20) throw new WorkerApiError('validation_failed', 400, 'A job may allocate at most 20 uploads.');
  });
  const targets = await Promise.all(input.files.map(async (file) => {
    const uploadId = newId();
    const uploadKey = `${createHash('sha256').update(input.leaseToken).digest('hex').slice(0, 24)}:${uploadId}`;
    const storageKey = `workers/${workerId}/jobs/${jobId}/${uploadId}`;
    const signed = await storage.signUpload(storageKey, file.contentType);
    return { uploadId, uploadKey, storageKey, signed, file };
  }));
  try {
    await db.transaction(async (tx) => {
      const [job] = await tx.select({ id: generationJobs.id, cancelRequested: generationJobs.cancelRequested }).from(generationJobs).where(leaseWhere(jobId, workerId, input.leaseToken, new Date())).for('update');
      if (!job || job.cancelRequested) throw new GenerationError('lease_lost');
      const [count] = await tx.select({ count: sql<number>`count(*)::int` }).from(workerUploads).where(eq(workerUploads.jobId, jobId));
      if ((count?.count ?? 0) + targets.length > 20) throw new WorkerApiError('validation_failed', 400, 'A job may allocate at most 20 uploads.');
      for (const target of targets) await tx.insert(workerUploads).values({ id: target.uploadId, workerId, jobId, leaseToken: input.leaseToken, uploadKey: target.uploadKey, storageKey: target.storageKey, sha256: target.file.sha256, contentType: target.file.contentType, bytes: target.file.bytes, expiresAt: new Date(target.signed.expiresAt) });
    });
  } catch (error) {
    for (const target of targets) await scheduleStorageCleanup(db, target.storageKey, 'rejected_upload', new Date(target.signed.expiresAt));
    throw error;
  }
  const response = { uploads: targets.map((target) => ({ uploadKey: target.uploadKey, url: target.signed.url, method: 'PUT' as const, headers: target.signed.headers, expiresAt: target.signed.expiresAt })) };
  assertContract('UploadsResponse', response);
  return response;
}

async function readUploads(db: Executor, storage: Storage, workerId: string, jobId: string, leaseToken: string, images: OutputImage[]): Promise<Array<{ upload: UploadRow; image: OutputImage; bytes: Buffer }>> {
  const output: Array<{ upload: UploadRow; image: OutputImage; bytes: Buffer }> = [];
  for (const image of images) {
    const [upload] = await db.select().from(workerUploads).where(and(eq(workerUploads.workerId, workerId), eq(workerUploads.jobId, jobId), eq(workerUploads.leaseToken, leaseToken), eq(workerUploads.uploadKey, image.uploadKey)));
    if (!upload) throw new WorkerApiError('upload_missing', 422);
    if (upload.sha256 !== image.sha256 || upload.bytes !== image.bytes || upload.contentType !== image.contentType) throw new WorkerApiError('checksum_mismatch', 422);
    try {
      const bytes = await storage.readVerified(upload.storageKey, { sha256: image.sha256, sizeBytes: image.bytes, contentType: image.contentType }, MAX_OUTPUT_BYTES);
      output.push({ upload, image, bytes });
    } catch (error) {
      throw new WorkerApiError(error instanceof AssetError && error.code === 'NOT_FOUND' ? 'upload_missing' : 'checksum_mismatch', 422);
    }
  }
  return output;
}
async function scheduleCleanup(db: Database | Executor, workerId: string, jobId: string, leaseToken: string, reason: string, now = new Date()) {
  const rows = await db.select({ storageKey: workerUploads.storageKey, expiresAt: workerUploads.expiresAt }).from(workerUploads).where(and(eq(workerUploads.workerId, workerId), eq(workerUploads.jobId, jobId), eq(workerUploads.leaseToken, leaseToken)));
  for (const row of rows) {
    const availableAt = new Date(Math.max(row.expiresAt.getTime() + UPLOAD_CLEANUP_GRACE_MS, now.getTime()));
    await db.insert(workerCleanup).values({ id: newId(), storageKey: row.storageKey, reason, availableAt }).onConflictDoNothing({ target: workerCleanup.storageKey });
  }
}
async function scheduleStorageCleanup(db: Database | Executor, storageKey: string, reason: string, availableAt = new Date()) {
  await db.insert(workerCleanup).values({ id: newId(), storageKey, reason, availableAt }).onConflictDoNothing({ target: workerCleanup.storageKey });
}

export async function completeWorkerJob(db: Database, storage: Storage, workerId: string, jobId: string, key: string, body: unknown, now = new Date()) {
  if (key.length < 8 || key.length > 128) throw new WorkerApiError('validation_failed', 400);
  if (body && typeof body === 'object' && !Array.isArray(body) && Array.isArray((body as Record<string, unknown>).images)) {
    for (const image of (body as Record<string, unknown>).images as unknown[]) {
      if (!image || typeof image !== 'object' || typeof (image as Record<string, unknown>).uploadKey !== 'string') throw new WorkerApiError('upload_missing', 422);
    }
  }
  assertInput('CompleteRequest', body);
  const input = body as CompleteRequest;
  if (input.images && (new Set(input.images.map((image) => image.uploadKey)).size !== input.images.length || new Set(input.images.map((image) => image.sha256)).size !== input.images.length)) throw new WorkerApiError('validation_failed', 422, 'Duplicate output images are not allowed.');
  type Candidate = { id: string; storageKey: string; upload: UploadRow; image: OutputImage; bytes: Buffer; copied: boolean };
  type Prepared = { candidates: Candidate[]; error?: { status: number; response: ReturnType<typeof problem> } };
  const candidates: Candidate[] = [];
  let prepared = false;
  try {
    return await withDurableIdempotency(db, { workerId, jobId, operation: 'complete', key }, body, async (tx, preparation: Prepared) => {
      if (preparation.error) return preparation.error;
      const [current] = await tx.select().from(generationJobs).where(and(eq(generationJobs.id, jobId), eq(generationJobs.workerId, workerId))).for('update');
      const committedAt = new Date();
      if (!current || current.status !== 'running' || current.cancelRequested || current.leaseToken !== input.leaseToken || !current.leaseExpiresAt || current.leaseExpiresAt <= committedAt) return { status: 409, response: problem('lease_lost', 409) };
      const resultIds: string[] = [];
      for (const candidate of preparation.candidates) {
        const [inserted] = await tx.insert(assets).values({ id: candidate.id, storeId: current.storeId, storageKey: candidate.storageKey, sha256: candidate.image.sha256, contentType: candidate.image.contentType, sizeBytes: candidate.image.bytes }).onConflictDoNothing({ target: [assets.storeId, assets.sha256] }).returning();
        const [existing] = inserted ? [inserted] : await tx.select().from(assets).where(and(eq(assets.storeId, current.storeId), eq(assets.sha256, candidate.image.sha256)));
        if (!existing || existing.contentType !== candidate.image.contentType || existing.sizeBytes !== candidate.image.bytes) throw new WorkerApiError('checksum_mismatch', 422);
        const [createdResult] = await tx.insert(workerResults).values({ id: newId(), workerId, jobId, assetId: existing.id, payload: { width: candidate.image.width, height: candidate.image.height } }).onConflictDoNothing({ target: [workerResults.jobId, workerResults.assetId] }).returning();
        const [savedResult] = createdResult ? [createdResult] : await tx.select().from(workerResults).where(and(eq(workerResults.jobId, jobId), eq(workerResults.assetId, existing.id)));
        if (!savedResult) throw new Error('Result persistence failed.');
        if (!resultIds.includes(savedResult.id)) resultIds.push(savedResult.id);
        await tx.update(workerUploads).set({ status: 'verified' }).where(eq(workerUploads.id, candidate.upload.id));
      }
      await completeJobWithResults(tx, { jobId, leaseToken: input.leaseToken }, { resultIds, resultPayload: input.payload as Record<string, unknown> | undefined, providerMeta: input.providerMeta as Record<string, unknown> | undefined }, committedAt);
      await scheduleCleanup(tx, workerId, jobId, input.leaseToken, 'completed_upload', committedAt);
      return { status: 200, response: { status: 'succeeded', resultIds } };
    }, async (): Promise<Prepared> => {
      prepared = true;
      const [snapshot] = await db.select().from(generationJobs).where(and(eq(generationJobs.id, jobId), eq(generationJobs.workerId, workerId), eq(generationJobs.leaseToken, input.leaseToken)));
      if (!snapshot || snapshot.status !== 'running' || snapshot.cancelRequested || !snapshot.leaseExpiresAt || snapshot.leaseExpiresAt <= now) return { candidates, error: { status: 409, response: problem('lease_lost', 409) } };
      validateJobOutput(snapshot.type, input);
      try {
        for (const image of input.images ?? []) {
          // Read/copy one image at a time; bounded memory, no database lock during I/O.
          const [verified] = await readUploads(db, storage, workerId, jobId, input.leaseToken, [image]);
          const candidate: Candidate = { ...verified!, id: newId(), storageKey: `stores/${snapshot.storeId}/worker-results/${newId()}`, copied: false };
          candidates.push(candidate);
          // Crash-safe intent precedes PUT. Normal losers are expedited after the commit/replay.
          await scheduleStorageCleanup(db, candidate.storageKey, 'unpublished_candidate', new Date(Date.now() + 3600_000));
          await storage.putVerified(candidate.storageKey, candidate.bytes, candidate.image.contentType);
          candidate.copied = true;
          candidate.bytes = Buffer.alloc(0);
        }
        // Use declared verified sizes after releasing the buffers.
        return { candidates };
      } catch (error) {
        if (error instanceof WorkerApiError) return { candidates, error: { status: error.status, response: problem(error.code, error.status) } };
        throw error;
      }
    });
  } finally {
    for (const candidate of candidates) {
      const [published] = await db.select({ id: assets.id }).from(assets).where(eq(assets.storageKey, candidate.storageKey));
      if (published) await db.update(workerCleanup).set({ completedAt: new Date() }).where(eq(workerCleanup.storageKey, candidate.storageKey));
      // Ambiguous failed PUTs retain their crash grace; a late write must not recreate an orphan.
      else if (candidate.copied) await db.update(workerCleanup).set({ availableAt: new Date() }).where(eq(workerCleanup.storageKey, candidate.storageKey));
    }
    if (prepared) await scheduleCleanup(db, workerId, jobId, input.leaseToken, 'completion_staging', new Date());
  }
}
export async function failWorkerJob(db: Database, workerId: string, jobId: string, key: string, body: unknown, _now = new Date()) {
  if (key.length < 8 || key.length > 128) throw new WorkerApiError('validation_failed', 400);
  assertInput('FailRequest', body);
  const input = body as FailRequest;
  return withDurableIdempotency(db, { workerId, jobId, operation: 'fail', key }, body, async (tx) => {
    const [current] = await tx.select().from(generationJobs).where(and(eq(generationJobs.id, jobId), eq(generationJobs.workerId, workerId), eq(generationJobs.leaseToken, input.leaseToken)));
    const clock = new Date();
    if (!current || current.status !== 'running' || !current.leaseExpiresAt || current.leaseExpiresAt <= clock) return { status: 409, response: problem('lease_lost', 409) };
    try {
      const row = await failJobInTransaction(tx, { jobId, leaseToken: input.leaseToken, errorClass: input.errorClass as ErrorClass, message: input.message, retryAfterSeconds: input.retryAfterSeconds }, sanitizeWorkerMessage(input.message), clock);
      await scheduleCleanup(tx, workerId, jobId, input.leaseToken, 'failed_upload', clock);
      return { status: 200, response: { jobStatus: row.status === 'queued' ? 'queued' : row.status === 'cancelled' ? 'cancelled' : 'failed', willRetry: row.status === 'queued' } };
    } catch (error) {
      if (error instanceof GenerationError) return { status: 409, response: problem('lease_lost', 409) };
      throw error;
    }
  });
}

export async function updateAccountStatus(db: Database, workerId: string, accountId: string, body: unknown, now = new Date()) {
  assertInput('AccountStatusRequest', body);
  const input = body as AccountStatusRequest;
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(providerAccounts).where(and(eq(providerAccounts.id, accountId), eq(providerAccounts.workerId, workerId))).for('update');
    if (!current) throw new WorkerApiError('not_found', 404);
    const [account] = await tx.update(providerAccounts).set({
      state: input.state,
      cooldownUntil: input.state === 'cooldown' && input.cooldownUntil ? new Date(input.cooldownUntil) : null,
      ...(input.installedSkills !== undefined ? { installedSkills: input.installedSkills } : {}),
      ...(input.state === 'available' ? { lastHealthyAt: now, sessionExpiresAt: null } : {}),
      updatedAt: now,
    }).where(eq(providerAccounts.id, accountId)).returning();
    if (!account) throw new WorkerApiError('not_found', 404);
    await writeAudit(tx, { actorUserId: null, action: 'worker.account_status', targetType: 'provider_account', targetId: account.id, data: { state: account.state } });
    const response = { accountId: account.id, state: account.state };
    assertContract('AccountStatusResponse', response);
    return response;
  });
}

export async function getSkillVersion(db: Database, storage: Storage, versionId: string) {
  const [version] = await db.select().from(skillVersions).where(and(eq(skillVersions.id, versionId), sql`${skillVersions.status} in ('published','deprecated')`));
  if (!version) throw new WorkerApiError('not_found', 404);
  const result: Record<string, unknown> = { versionId: version.id, status: version.status, manifest: version.manifest, checksum: version.checksum };
  if (version.artifactKey) { const signed = await storage.signRead(version.artifactKey, 'application/octet-stream'); result.artifactUrl = signed.url; result.artifactUrlExpiresAt = signed.expiresAt; }
  assertContract('SkillVersionResponse', result);
  return result;
}

export async function runCleanup(storage: Storage, db: Database, limit = 100) {
  const expired = await db.select({ storageKey: workerUploads.storageKey, expiresAt: workerUploads.expiresAt })
    .from(workerUploads)
    .where(sql`${workerUploads.expiresAt} <= now() and ${workerUploads.status} <> 'deleted'`)
    .limit(limit);
  for (const row of expired) await scheduleStorageCleanup(db, row.storageKey, 'expired_upload', new Date(row.expiresAt.getTime() + UPLOAD_CLEANUP_GRACE_MS));
  const rows = await db.select().from(workerCleanup).where(sql`${workerCleanup.completedAt} is null and ${workerCleanup.availableAt} <= now()`).limit(limit);
  let completed = 0;
  for (const row of rows) {
    try {
      const [published] = await db.select({ id: assets.id }).from(assets).where(eq(assets.storageKey, row.storageKey));
      if (published) {
        await db.update(workerCleanup).set({ completedAt: new Date(), attempts: row.attempts + 1, updatedAt: new Date() }).where(eq(workerCleanup.id, row.id));
        continue;
      }
      await storage.delete(row.storageKey);
      await db.update(workerCleanup).set({ completedAt: new Date(), attempts: row.attempts + 1, updatedAt: new Date() }).where(eq(workerCleanup.id, row.id));
      await db.update(workerUploads).set({ status: 'deleted', updatedAt: new Date() }).where(eq(workerUploads.storageKey, row.storageKey));
      completed++;
    }
    catch { await db.update(workerCleanup).set({ attempts: row.attempts + 1, availableAt: new Date(Date.now() + Math.min(300, 2 ** Math.min(row.attempts, 8)) * 1000), updatedAt: new Date() }).where(eq(workerCleanup.id, row.id)); }
  }
  return completed;
}
