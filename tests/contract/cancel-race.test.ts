import { describe, expect, it } from 'vitest';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { eq, generationJobs, assets, workerResults, workerCleanup } from '../../packages/db/src/index';
import { cancelJob, runCleanup } from '../../packages/core/src/index';
import { owner } from '../../packages/core/test/generation/harness';
import { call, checked, lease, upload, workerHarness, imageBytes } from './harness';

describe('Worker API cancel/complete races', () => {
  it('runs 100 concurrent pairs with one final state and deletes every losing upload', async () => {
    const h = await workerHarness();
    const ids: string[] = [];
    for (let index = 0; index < 100; index++) {
      const job = await lease(h);
      ids.push(job.id);
      const input = await upload(h, job, Buffer.concat([imageBytes, Buffer.from(String(index))]));
      const pair = await Promise.allSettled([
        cancelJob(h.db, owner, job.id),
        call(h.api, h.token, 'complete', input, job.id, { key: `cancel-race-${index}` }),
      ]);
      expect(pair[1]!.status).toBe('fulfilled');
      const completion = (pair[1] as PromiseFulfilledResult<Response>).value;
      if (completion.status === 200) await checked(completion, 'CompleteResponse', 200);
      else await checked(completion, 'Problem', 409);
      let [row] = await h.db.select().from(generationJobs).where(eq(generationJobs.id, job.id));
      if (row!.status === 'running' && row!.cancelRequested) {
        await checked(await call(h.api, h.token, 'fail', { leaseToken: job.leaseToken, errorClass: 'cancelled', message: 'Cancelled by requester.' }, job.id, { key: `cancel-ack-${index}` }), 'FailResponse', 200);
        [row] = await h.db.select().from(generationJobs).where(eq(generationJobs.id, job.id));
      }
      expect(['cancelled', 'completed']).toContain(row!.status);
      expect(row!.leaseToken).toBeNull();
      const results = await h.db.select().from(workerResults).where(eq(workerResults.jobId, job.id));
      expect(results).toHaveLength(row!.status === 'completed' ? 1 : 0);
      // Avoid per-process HTTP-rate limits while preserving the actual handler for every race.
      h.api = (await import('../../apps/web/src/features/workers/handler')).createWorkerApi({ database: () => h.db, storage: () => h.storage });
    }
    await new Promise((resolve) => setTimeout(resolve, 11_100));
    for (let batch = 0; batch < 5; batch++) await runCleanup(h.storage, h.db, 1000);
    const objects = await h.bucket.client.send(new ListObjectsV2Command({ Bucket: h.bucket.name }));
    const published = await h.db.select().from(assets);
    expect(new Set((objects.Contents ?? []).map((object) => object.Key))).toEqual(new Set(published.map((asset) => asset.storageKey)));
    const deletions = await h.db.select().from(workerCleanup);
    expect(deletions.length).toBeGreaterThanOrEqual(100);
    expect(deletions.every((task) => task.completedAt !== null)).toBe(true);
    expect(ids).toHaveLength(100);
  }, 120_000);
});
