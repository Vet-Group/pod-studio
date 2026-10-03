import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { assets, eq, providerAccounts, workerResults } from '../../packages/db/src/index';
import { claimJob, completeWorkerJob, createStorage, createWorkerUploads } from '../../packages/core/src/index';
import { createTestBucket, type TestBucket } from '../support/storage';
import { harness, jobs, now } from '../../packages/core/test/generation/harness';

const buckets: TestBucket[] = [];
afterEach(async () => { while (buckets.length) await buckets.pop()!.drop(); });

describe('worker API storage integration', () => {
  it('verifies a real MinIO upload, publishes an immutable asset and replays the same result', async () => {
    const h = await harness();
    const bucket = await createTestBucket();
    buckets.push(bucket);
    const storage = createStorage({ client: bucket.client, signingClient: bucket.client, bucket: bucket.name });
    await h.db.update(providerAccounts).set({ sessionExpiresAt: new Date(Date.now() + 3600_000) }).where(eq(providerAccounts.id, h.accountId));
    const [created] = await jobs(h.db, 1, { prompt: 'Create a poster.', params: { productType: 'poster', count: 1, ratio: '3:4', mode: 'generate' } });
    const leased = await claimJob(h.db, { workerId: h.workerId, accountId: h.accountId });
    expect(leased?.id).toBe(created?.id);
    const bytes = Buffer.from('worker output integration');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const uploadBody = { leaseToken: leased!.leaseToken!, files: [{ contentType: 'image/png' as const, bytes: bytes.length, sha256 }] };
    const [target] = (await createWorkerUploads(h.db, storage, h.workerId, leased!.id, uploadBody, now)).uploads;
    const put = await fetch(target!.url, { method: 'PUT', headers: target!.headers, body: bytes });
    expect(put.ok).toBe(true);
    const completeBody = { leaseToken: leased!.leaseToken!, images: [{ uploadKey: target!.uploadKey, sha256, contentType: 'image/png' as const, width: 10, height: 10, bytes: bytes.length }] };
    const first = await completeWorkerJob(h.db, storage, h.workerId, leased!.id, 'integration-key-1', completeBody, now);
    const replay = await completeWorkerJob(h.db, storage, h.workerId, leased!.id, 'integration-key-1', completeBody, now);
    expect(first).toEqual(replay);
    expect(first.status).toBe(200);
    expect(first.response).toMatchObject({ resultIds: expect.arrayContaining([expect.any(String)]) });
    expect(await h.db.select().from(workerResults).where(eq(workerResults.jobId, leased!.id))).toHaveLength(1);
    expect(await h.db.select().from(assets).where(eq(assets.storeId, created!.storeId))).toHaveLength(1);
  }, 30_000);
});
