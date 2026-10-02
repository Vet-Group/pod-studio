import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import * as core from '../../packages/core/src/index';
vi.mock('../../packages/core/src/index', async (original) => {
  const actual = await original<typeof core>();
  return { ...actual, claimWorkerJob: vi.fn(actual.claimWorkerJob), authenticateWorker: vi.fn(actual.authenticateWorker) };
});
import { eq, generationJobs, workerResults, workerIdempotency, skillVersions, auditLog, workers, workerCleanup, workerUploads } from '../../packages/db/src/index';
import { revokeWorker, authenticateWorker, runCleanup } from '../../packages/core/src/index';
import { validateContract, type components } from '../../packages/contracts/src/index';
import { call, checked, lease, upload, workerHarness, imageBytes, sha256 } from './harness';

async function problem(response: Response, status: number, code: string) {
  const result = await checked<{ code: string }>(response, 'Problem', status);
  expect(result.code).toBe(code);
}

describe('Worker API v2 HTTP contract', () => {
  it('validates real register, claim, heartbeat, uploads, complete, account status and skill responses with Ajv', async () => {
    const h = await workerHarness();
    const job = await lease(h);
    const heartbeat = await checked<components['schemas']['HeartbeatResponse']>(await call(h.api, h.token, 'heartbeat', { leaseToken: job.leaseToken, progress: { percent: 50, stage: 'downloading' } }, job.id), 'HeartbeatResponse', 200);
    expect(new Date(heartbeat.leaseExpiresAt).getTime()).toBeGreaterThan(Date.now() + 170_000);
    const input = await upload(h, job);
    const complete = await checked<components['schemas']['CompleteResponse']>(await call(h.api, h.token, 'complete', input, job.id, { key: 'complete-success-key' }), 'CompleteResponse', 200);
    expect(complete.resultIds).toHaveLength(1);
    expect(await h.db.select().from(workerResults).where(eq(workerResults.jobId, job.id))).toHaveLength(1);
    await checked(await call(h.api, h.token, 'account-status', { state: 'available', installedSkills: [{ slug: 'create-wall-art-mockups', version: '1.0.0' }] }, h.accountId), 'AccountStatusResponse', 200);
    const fixture = JSON.parse(readFileSync(join(process.cwd(), 'packages/contracts/examples/worker/skill-version.response.json'), 'utf8')) as components['schemas']['SkillVersionResponse'];
    await h.db.insert(skillVersions).values({ id: fixture.versionId, skillId: 'skill_fixture', checksum: fixture.checksum, manifest: fixture.manifest as unknown as Record<string, unknown>, status: 'published' });
    await checked(await call(h.api, h.token, 'skill-version', undefined, fixture.versionId), 'SkillVersionResponse', 200);
    const audits = await h.db.select().from(auditLog);
    expect(audits.filter((row) => row.action === 'worker.register')).toHaveLength(1);
    expect(audits.filter((row) => row.action === 'generation_job.complete')).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(h.token);
  });

  it('replays concurrent completion after cleanup without duplicate results or audit rows', async () => {
    const h = await workerHarness();
    const job = await lease(h);
    const input = await upload(h, job);
    const responses = await Promise.all(Array.from({ length: 8 }, () => call(h.api, h.token, 'complete', input, job.id, { key: 'concurrent-complete' })));
    const results = await Promise.all(responses.map((response) => checked(response, 'CompleteResponse', 200)));
    for (const result of results) expect(result).toEqual(results[0]);
    await new Promise((resolve) => setTimeout(resolve, 11_100));
    await runCleanup(h.storage, h.db);
    expect(await checked(await call(h.api, h.token, 'complete', { ...input }, job.id, { key: 'concurrent-complete' }), 'CompleteResponse', 200)).toEqual(results[0]);
    expect(await h.db.select().from(workerResults).where(eq(workerResults.jobId, job.id))).toHaveLength(1);
    expect(await h.db.select().from(workerIdempotency).where(eq(workerIdempotency.jobId, job.id))).toHaveLength(1);
    const audits = await h.db.select().from(auditLog).where(eq(auditLog.targetId, job.id));
    expect(audits.filter((row) => row.action === 'generation_job.complete')).toHaveLength(1);
    await problem(await call(h.api, h.token, 'complete', { ...input, providerMeta: { model: 'different' } }, job.id, { key: 'concurrent-complete' }), 422, 'idempotency_key_reused');
    await problem(await call(h.api, h.token, 'fail', { leaseToken: job.leaseToken, errorClass: 'transient', message: 'Retry' }, job.id, { key: 'concurrent-complete' }), 422, 'idempotency_key_reused');
  });

  it('returns 409 lease_lost for stale heartbeat, uploads, complete and fail leases', async () => {
    const h = await workerHarness();
    const job = await lease(h);
    await h.db.update(generationJobs).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(generationJobs.id, job.id));
    await problem(await call(h.api, h.token, 'heartbeat', { leaseToken: job.leaseToken }, job.id), 409, 'lease_lost');
    await problem(await call(h.api, h.token, 'uploads', { leaseToken: job.leaseToken, files: [{ contentType: 'image/png', bytes: imageBytes.length, sha256: sha256(imageBytes) }] }, job.id), 409, 'lease_lost');
    await problem(await call(h.api, h.token, 'complete', { leaseToken: job.leaseToken, images: [{ uploadKey: 'unknown-upload-key', sha256: sha256(imageBytes), contentType: 'image/png', bytes: imageBytes.length, width: 1, height: 1 }] }, job.id, { key: 'stale-complete-key' }), 409, 'lease_lost');
    await problem(await call(h.api, h.token, 'fail', { leaseToken: job.leaseToken, errorClass: 'transient', message: 'Transient failure' }, job.id, { key: 'stale-failure-key' }), 409, 'lease_lost');
  });

  it('rejects missing or unknown uploadKey and actual object checksum mismatch with 422', async () => {
    const h = await workerHarness();
    const job = await lease(h);
    await problem(await call(h.api, h.token, 'complete', { leaseToken: job.leaseToken, images: [{ sha256: sha256(imageBytes), contentType: 'image/png', bytes: imageBytes.length, width: 1, height: 1 }] }, job.id, { key: 'missing-upload-key' }), 422, 'upload_missing');
    await problem(await call(h.api, h.token, 'complete', { leaseToken: job.leaseToken, images: [{ uploadKey: 'unknown-key', sha256: sha256(imageBytes), contentType: 'image/png', bytes: imageBytes.length, width: 1, height: 1 }] }, job.id, { key: 'unknown-upload-key' }), 422, 'upload_missing');
    const wrong = await upload(h, job, imageBytes, 'a'.repeat(64));
    await problem(await call(h.api, h.token, 'complete', wrong, job.id, { key: 'checksum-mismatch' }), 422, 'checksum_mismatch');
    expect(await h.db.select().from(workerResults)).toHaveLength(0);
  });

  it('requires contract version 2 and rejects unknown/revoked tokens with secret-free audits', async () => {
    const h = await workerHarness();
    for (const version of [null, '1', '2.0.0-draft.1']) await problem(await call(h.api, h.token, 'claim', {}, undefined, { version }), 426, 'contract_version_unsupported');
    await problem(await call(h.api, 'x'.repeat(43), 'claim', {}), 401, 'unauthorized');
    await revokeWorker(h.db, h.admin, h.workerId);
    expect(await authenticateWorker(h.db, h.token)).toBeNull();
    await problem(await call(h.api, h.token, 'claim', {}), 401, 'unauthorized');
    const [stored] = await h.db.select().from(workers).where(eq(workers.id, h.workerId));
    expect(stored!.tokenHash).not.toBe(h.token);
    const audits = await h.db.select().from(auditLog);
    expect(audits.filter((row) => row.action === 'worker.revoke')).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(h.token);
  });

  it('validates concurrent failure replay without duplicate audits', async () => {
    const h = await workerHarness();
    const job = await lease(h);
    const body = { leaseToken: job.leaseToken, errorClass: 'provider_refused', message: 'Provider refused the image.' };
    const responses = await Promise.all(Array.from({ length: 5 }, () => call(h.api, h.token, 'fail', body, job.id, { key: 'same-failure-key' })));
    const results = await Promise.all(responses.map((response) => checked<components['schemas']['FailResponse']>(response, 'FailResponse', 200)));
    expect(results.every((value) => value.jobStatus === 'failed' && !value.willRetry)).toBe(true);
    const audits = await h.db.select().from(auditLog).where(eq(auditLog.targetId, job.id));
    expect(audits.filter((row) => row.action === 'generation_job.fail')).toHaveLength(1);
  });

  it('bounds long-poll and stops the explicit wait on client abort', async () => {
    const h = await workerHarness();
    const request = { workerId: h.workerId, accountId: h.accountId, waitSeconds: 0 };
    expect((await call(h.api, h.token, 'claim', request)).status).toBe(204);
    await problem(await call(h.api, h.token, 'claim', { ...request, waitSeconds: 26 }), 400, 'validation_failed');
    const controller = new AbortController();
    const start = Date.now();
    const pending = call(h.api, h.token, 'claim', { ...request, waitSeconds: 25 }, undefined, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect((await pending).status).toBe(204);
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it('rejects oversized streamed bodies without trusting Content-Length', async () => {
    const h = await workerHarness();
    await problem(await call(h.api, h.token, 'register', { padding: 'x'.repeat(1024 * 1024) }), 400, 'validation_failed');
    await problem(await call(h.api, h.token, 'account-status', { state: 'invalid' }, h.accountId), 400, 'validation_failed');
  });

  it('preserves failed staging cleanup until PUT expiry plus grace and never deletes before expiry', async () => {
    const h = await workerHarness();
    const job = await lease(h);
    const input = await upload(h, job, imageBytes, 'b'.repeat(64));
    await problem(await call(h.api, h.token, 'complete', input, job.id, { key: 'cleanup-expiry-regression' }), 422, 'checksum_mismatch');
    const [staging] = await h.db.select().from(workerUploads).where(eq(workerUploads.jobId, job.id));
    const [task] = await h.db.select().from(workerCleanup).where(eq(workerCleanup.storageKey, staging!.storageKey));
    expect(task!.availableAt.getTime()).toBeGreaterThanOrEqual(staging!.expiresAt.getTime() + 1000);
    const deletion = vi.spyOn(h.storage, 'delete');
    await runCleanup(h.storage, h.db);
    expect(deletion).not.toHaveBeenCalled();
    await h.bucket.client.send(new HeadObjectCommand({ Bucket: h.bucket.name, Key: staging!.storageKey }));
    expect(task!.completedAt).toBeNull();
  });

  it('defaults omitted waitSeconds to an immediate empty response', async () => {
    const h = await workerHarness();
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 1800);
    const start = Date.now();
    const response = await call(h.api, h.token, 'claim', { workerId: h.workerId, accountId: h.accountId }, undefined, { signal: controller.signal });
    clearTimeout(deadline);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('rejects duplicate upload keys and duplicate content identities with validated 422 problems', async () => {
    const h = await workerHarness();
    const job = await lease(h);
    const first = await upload(h, job);
    await problem(await call(h.api, h.token, 'complete', { ...first, images: [first.images[0], first.images[0]] }, job.id, { key: 'duplicate-upload-key' }), 422, 'validation_failed');
    const second = await upload(h, job);
    await problem(await call(h.api, h.token, 'complete', { ...first, images: [first.images[0], second.images[0]] }, job.id, { key: 'duplicate-content-hash' }), 422, 'validation_failed');
    expect(await h.db.select().from(workerResults).where(eq(workerResults.jobId, job.id))).toHaveLength(0);
  });

  it('backs off claim queries and stops issuing them promptly after abort', async () => {
    const h = await workerHarness();
    vi.mocked(core.claimWorkerJob).mockClear();
    vi.mocked(core.authenticateWorker).mockClear();
    const controller = new AbortController();
    const pending = call(h.api, h.token, 'claim', { workerId: h.workerId, accountId: h.accountId, waitSeconds: 25 }, undefined, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 1150));
    controller.abort();
    expect((await pending).status).toBe(204);
    const claims = vi.mocked(core.claimWorkerJob).mock.calls.length;
    const authentications = vi.mocked(core.authenticateWorker).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(vi.mocked(core.claimWorkerJob).mock.calls).toHaveLength(claims);
    expect(claims).toBeLessThanOrEqual(2);
    expect(authentications).toBe(1);
  });

  it('validates every published worker response example with shared Ajv schemas', () => {
    const root = join(process.cwd(), 'packages/contracts/examples/worker');
    const targets: Array<[RegExp, Parameters<typeof validateContract>[0]]> = [
      [/^register\.response/, 'RegisterResponse'], [/^claim\..+\.response/, 'ClaimResponse'], [/^heartbeat\.response/, 'HeartbeatResponse'],
      [/^uploads\.response/, 'UploadsResponse'], [/^complete\.response/, 'CompleteResponse'], [/^fail\.response/, 'FailResponse'],
      [/^account-status\.response/, 'AccountStatusResponse'], [/^skill-version\.response/, 'SkillVersionResponse'],
    ];
    let validated = 0;
    for (const file of readdirSync(root)) {
      const target = targets.find(([pattern]) => pattern.test(file));
      if (!target) continue;
      expect(validateContract(target[1], JSON.parse(readFileSync(join(root, file), 'utf8')) as unknown), file).toEqual([]);
      validated++;
    }
    expect(validated).toBe(9);
  });
});
