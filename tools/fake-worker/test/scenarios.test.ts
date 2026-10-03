import { createHash, randomUUID } from 'node:crypto';
import { crc32, inflateSync } from 'node:zlib';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { validateContract } from '@pod-studio/contracts';
import { assets, eq, generationJobs, newId, providerAccounts, workerResults, workerUploads } from '../../../packages/db/src/index';
import { A, jobs, owner } from '../../../packages/core/test/generation/harness';
import { reapExpiredLeases } from '../../../apps/jobs/src/reapers/lease-reaper';
import { runScenario } from '../src/scenarios';
import type { ClaimedJob, JobType } from '../src/client';
import { httpHarness } from './http-harness';

const jobTypes: JobType[] = ['mockup', 'redesign', 'listing_content', 'product_analysis'];
const params = {
  mockup: { productType: 'poster', count: 2, ratio: '3:4', minLongEdge: 512, mode: 'generate' },
  redesign: { count: 2, ratio: '3:4', minLongEdge: 512, intent: 'variation' },
  listing_content: { locale: 'en-US', niche: 'nature', productType: 'poster' },
  product_analysis: { locale: 'en-US' },
};
type Harness = Awaited<ReturnType<typeof httpHarness>>;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function seedAndClaim(h: Harness, type: JobType, input = false): Promise<ClaimedJob> {
  let assetId: string | undefined;
  if (input) {
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP4sAAAAASUVORK5CYII=', 'base64');
    assetId = newId();
    const key = `test-input/${assetId}.png`;
    await h.bucket.client.send(new PutObjectCommand({ Bucket: h.bucket.name, Key: key, Body: bytes, ContentType: 'image/png' }));
    await h.db.insert(assets).values({ id: assetId, storeId: A, sha256: digest(bytes), storageKey: key, contentType: 'image/png', sizeBytes: bytes.length, createdBy: owner.userId });
  }
  const [created] = await jobs(h.db, 1, { type, prompt: 'Create a deterministic nature poster.', model: 'fake-test-model', params: params[type], assetId });
  const job = await h.claim();
  expect(job?.id).toBe(created!.id);
  expect(job?.type).toBe(type);
  if (!job) throw new Error('Expected a claimed job');
  expect(job.inputs).toHaveLength(input ? 1 : 0);
  return job;
}
async function jobRow(h: Harness, id: string) {
  const [row] = await h.db.select().from(generationJobs).where(eq(generationJobs.id, id));
  return row!;
}
async function assertOutput(h: Harness, job: ClaimedJob) {
  const saved = await jobRow(h, job.id);
  expect(saved).toMatchObject({ status: 'completed' });
  const results = await h.db.select().from(workerResults).where(eq(workerResults.jobId, job.id));
  const image = job.type === 'mockup' || job.type === 'redesign';
  expect(results).toHaveLength(image ? 2 : 0);
  if (!image) {
    expect(validateContract(job.type === 'listing_content' ? 'ListingContentPayload' : 'ProductAnalysisPayload', saved.resultPayload)).toEqual([]);
    expect(saved.resultIds).toEqual([]);
  }
  for (const result of results) {
    expect(result.payload).toEqual({ width: 384, height: 512 });
    const [asset] = await h.db.select().from(assets).where(eq(assets.id, result.assetId!));
    expect(asset?.contentType).toBe('image/png');
    const signed = await h.storage.signRead(asset!.storageKey, asset!.contentType);
    const response = await fetch(signed.url);
    expect(response.status).toBe(200);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.length).toBe(asset!.sizeBytes);
    expect(digest(bytes)).toBe(asset!.sha256);
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(bytes.readUInt32BE(16)).toBe(384);
    expect(bytes.readUInt32BE(20)).toBe(512);
    const data: Buffer[] = [];
    for (let offset = 8; offset < bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      const chunk = bytes.subarray(offset + 4, offset + 8 + length);
      expect(crc32(chunk)).toBe(bytes.readUInt32BE(offset + 8 + length));
      if (chunk.subarray(0, 4).toString() === 'IDAT') data.push(chunk.subarray(4));
      offset += length + 12;
    }
    const channels = bytes[25] === 6 ? 4 : 3;
    expect(inflateSync(Buffer.concat(data)).length).toBe((384 * channels + 1) * 512);
  }
}

describe.each(jobTypes)('fake-worker %s against real HTTP, PostgreSQL and MinIO', (type) => {
  it('completes with verified image bytes or contract-valid JSON', async () => {
    const h = await httpHarness();
    const job = await seedAndClaim(h, type, true);
    expect(await runScenario(h.client, job, h.registration, 'success')).toMatchObject({ outcome: 'completed' });
    await assertOutput(h, job);
    expect(h.trace.map((entry) => entry.operation)).toContain('complete');
  });

  it('renews its lease repeatedly during slow execution', async () => {
    const h = await httpHarness();
    const job = await seedAndClaim(h, type);
    const outcome = await runScenario(h.client, job, h.registration, 'slow', { slowDurationMs: 2000, heartbeatIntervalMs: 200 });
    expect(outcome.outcome).toBe('completed');
    expect(outcome.heartbeatCount).toBeGreaterThanOrEqual(2);
    const beats = h.trace.filter((entry) => entry.operation === 'heartbeat');
    expect(beats).toHaveLength(outcome.heartbeatCount);
    for (const beat of beats) {
      expect(beat.status).toBe(200);
      const body = beat.body as { leaseExpiresAt: string };
      expect(Date.parse(body.leaseExpiresAt)).toBeGreaterThan(Date.parse(job.leaseExpiresAt));
    }
    await assertOutput(h, job);
  });

  it('rate limit puts the account in cooldown without consuming a job attempt', async () => {
    const h = await httpHarness();
    const job = await seedAndClaim(h, type);
    const before = await jobRow(h, job.id);
    await runScenario(h.client, job, h.registration, 'rate_limit');
    expect(await jobRow(h, job.id)).toMatchObject({ status: 'queued', attempt: before.attempt, accountRequeues: before.accountRequeues + 1, errorClass: 'account_rate_limited', leaseToken: null });
    const [account] = await h.db.select().from(providerAccounts).where(eq(providerAccounts.id, h.accountId));
    expect(account!.state).toBe('cooldown');
    expect(account!.cooldownUntil!.getTime()).toBeGreaterThan(Date.now());
    await expect(h.claim()).rejects.toMatchObject({ status: 409, code: 'account_not_claimable' });
    await h.client.accountStatus(h.accountId, { state: 'available' });
    const retried = await h.claim();
    expect(retried!.id).toBe(job.id);
    expect(retried!.leaseToken).not.toBe(job.leaseToken);
  });

  it('expired session stops account claims and requeues without consuming an attempt', async () => {
    const h = await httpHarness();
    const job = await seedAndClaim(h, type);
    const before = await jobRow(h, job.id);
    await runScenario(h.client, job, h.registration, 'expired_session');
    expect(await jobRow(h, job.id)).toMatchObject({ status: 'queued', attempt: before.attempt, errorClass: 'account_session_expired', leaseToken: null });
    const [account] = await h.db.select().from(providerAccounts).where(eq(providerAccounts.id, h.accountId));
    expect(account!.state).toBe('session_expired');
    await expect(h.claim()).rejects.toMatchObject({ status: 409, code: 'account_not_claimable' });
    expect(await h.db.select().from(workerResults).where(eq(workerResults.jobId, job.id))).toHaveLength(0);
  });

  it('abandons the lease; real reaper requeues it and stale writes are rejected over HTTP', async () => {
    const h = await httpHarness();
    const job = await seedAndClaim(h, type);
    const before = await jobRow(h, job.id);
    const traceLength = h.trace.length;
    expect(await runScenario(h.client, job, h.registration, 'lease_timeout')).toMatchObject({ outcome: 'abandoned', heartbeatCount: 0 });
    expect(h.trace).toHaveLength(traceLength);
    expect(await reapExpiredLeases(h.db)).toBe(0);
    // Only the persisted test lease is expired: no global fake clock and no 180s sleep.
    await h.db.update(generationJobs).set({ leaseExpiresAt: new Date(Date.now() - 1) }).where(eq(generationJobs.id, job.id));
    await expect(h.client.heartbeat(job.id, { leaseToken: job.leaseToken })).rejects.toMatchObject({ status: 409, code: 'lease_lost' });
    expect(await reapExpiredLeases(h.db)).toBe(1);
    expect(await jobRow(h, job.id)).toMatchObject({ status: 'queued', attempt: before.attempt + 1, errorClass: 'transient', leaseToken: null });
    await h.db.update(generationJobs).set({ availableAt: new Date(Date.now() - 1) }).where(eq(generationJobs.id, job.id));
    const retried = await h.claim();
    expect(retried!.id).toBe(job.id);
    expect(retried!.leaseToken).not.toBe(job.leaseToken);
    await expect(h.client.fail(job.id, { leaseToken: job.leaseToken, errorClass: 'transient', message: 'stale test worker' }, randomUUID())).rejects.toMatchObject({ status: 409, code: 'lease_lost' });
    await runScenario(h.client, retried!, h.registration, 'success');
    await assertOutput(h, retried!);
  });
});

describe.each(['mockup', 'redesign'] as const)('fake-worker %s checksum mismatch', (type) => {
  it('uploads to MinIO but publishes neither results nor assets after HTTP 422', async () => {
    const h = await httpHarness();
    const job = await seedAndClaim(h, type);
    const outcome = await runScenario(h.client, job, h.registration, 'checksum_mismatch');
    expect(outcome.outcome).toBe('rejected');
    expect(h.trace.filter((entry) => entry.operation === 'complete')).toEqual([
      expect.objectContaining({ status: 422, body: expect.objectContaining({ code: 'checksum_mismatch' }) }),
    ]);
    expect((await jobRow(h, job.id)).status).toBe('running');
    expect(await h.db.select().from(workerResults).where(eq(workerResults.jobId, job.id))).toHaveLength(0);
    expect(await h.db.select().from(assets)).toHaveLength(0);
    const uploads = await h.db.select().from(workerUploads).where(eq(workerUploads.jobId, job.id));
    expect(uploads).toHaveLength(2);
    for (const upload of uploads) {
      const signed = await h.storage.signRead(upload.storageKey, upload.contentType);
      const response = await fetch(signed.url);
      expect(response.status).toBe(200);
      expect(digest(Buffer.from(await response.arrayBuffer()))).toBe(upload.sha256);
    }
  });
});
