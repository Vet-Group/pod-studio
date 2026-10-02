import { afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { eq, type generationJobs, providerAccounts, users, type Database } from '../../packages/db/src/index';
import { createStorage, provisionWorker } from '../../packages/core/src/index';
import { harness, jobs } from '../../packages/core/test/generation/harness';
import { createTestBucket } from '../support/storage';
import { createWorkerApi, type WorkerOperation } from '../../apps/web/src/features/workers/handler';
import { validateContract, type ContractSchemaName, type components } from '../../packages/contracts/src/index';
import { expect } from 'vitest';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
export const imageBytes = Buffer.from('verified-worker-image');
export const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
export async function workerHarness() {
  process.env.S3_ENDPOINT = 'http://127.0.0.1:19000';
  const h = await harness();
  const bucket = await createTestBucket();
  cleanup.push(() => bucket.drop());
  const storage = createStorage({ client: bucket.client, bucket: bucket.name, uploadExpiresIn: 10 });
  const admin = { userId: 'worker_admin', role: 'admin' as const };
  await h.db.insert(users).values({ id: admin.userId, name: 'Worker admin', email: 'worker-admin@example.test', role: 'admin' });
  const issued = await provisionWorker(h.db, admin, { workerKey: 'browser-01@studio', host: 'worker-host', version: '1.0.0' });
  const api = createWorkerApi({ database: () => h.db, storage: () => storage });
  const registered = await call(api, issued.token, 'register', {
    workerKey: 'browser-01@studio', host: 'worker-host', version: '1.0.0',
    accounts: [{ accountKey: 'chatgpt-account', provider: 'chatgpt', channel: 'browser', jobTypes: ['mockup', 'redesign', 'listing_content', 'product_analysis'], installedSkills: [] }],
  });
  const response = await checked<components['schemas']['RegisterResponse']>(registered, 'RegisterResponse', 200);
  return { ...h, ...issued, admin, bucket, storage, api, accountId: response.accounts[0]!.accountId };
}
export function call(api: ReturnType<typeof createWorkerApi>, token: string, operation: WorkerOperation, body?: unknown, id?: string, options: { key?: string; version?: string | null; signal?: AbortSignal } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  if (options.version !== null) headers['x-contract-version'] = options.version ?? '2';
  if (options.key) headers['idempotency-key'] = options.key;
  const request = new Request(`http://localhost/api/worker/v2/${operation}`, { method: operation === 'skill-version' ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: options.signal });
  return api.dispatch(request, operation, id);
}
export async function checked<T>(response: Response, schema: ContractSchemaName, status: number): Promise<T> {
  const data: unknown = await response.json();
  expect(response.status, JSON.stringify(data)).toBe(status);
  expect(validateContract(schema, data), JSON.stringify(data)).toEqual([]);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return data as T;
}
export async function lease(h: Awaited<ReturnType<typeof workerHarness>>, overrides: Partial<typeof generationJobs.$inferInsert> = {}) {
  const [job] = await jobs(h.db, 1, { type: 'mockup', provider: 'chatgpt', prompt: 'Generate a poster mockup.', params: { productType: 'poster', count: 1, ratio: '3:4', mode: 'generate' }, ...overrides });
  const response = await call(h.api, h.token, 'claim', { workerId: h.workerId, accountId: h.accountId, waitSeconds: 0 });
  const result = await checked<components['schemas']['ClaimResponse']>(response, 'ClaimResponse', 200);
  expect(result.job.id).toBe(job!.id);
  return result.job;
}
export async function upload(h: Awaited<ReturnType<typeof workerHarness>>, job: components['schemas']['ClaimedJob'], bytes = imageBytes, declared = sha256(bytes)) {
  const response = await call(h.api, h.token, 'uploads', { leaseToken: job.leaseToken, files: [{ contentType: 'image/png', bytes: bytes.length, sha256: declared }] }, job.id);
  const targets = await checked<components['schemas']['UploadsResponse']>(response, 'UploadsResponse', 200);
  const target = targets.uploads[0]!;
  const put = await fetch(target.url, { method: 'PUT', headers: target.headers, body: bytes });
  expect(put.status).toBe(200);
  return { leaseToken: job.leaseToken, images: [{ uploadKey: target.uploadKey, sha256: declared, contentType: 'image/png' as const, bytes: bytes.length, width: 1, height: 1 }] };
}
export async function setConcurrency(db: Database, accountId: string, count: number) {
  await db.update(providerAccounts).set({ maxConcurrency: count }).where(eq(providerAccounts.id, accountId));
}
