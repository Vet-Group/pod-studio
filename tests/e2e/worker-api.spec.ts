import { randomBytes } from 'node:crypto';
import { expect, test, type APIResponse } from '@playwright/test';
import { provisionWorker, revokeWorker, type Principal } from '../../packages/core/src';
import { eq, generationJobs, newId, providerAccounts, workerResults } from '../../packages/db/src';
import { validateContract, type ContractSchemaName, type components } from '../../packages/contracts/src';
import { seedActiveAccount, seedStore, withDatabase } from './fixtures';

const admin = (): Principal => ({ userId: process.env.POD_E2E_ADMIN_ID!, role: 'admin' });
async function validated<T>(response: APIResponse, schema: ContractSchemaName, status: number): Promise<T> {
  const value: unknown = await response.json();
  expect(response.status(), JSON.stringify(value)).toBe(status);
  expect(validateContract(schema, value), JSON.stringify(value)).toEqual([]);
  return value as T;
}

test('Worker API routes authenticate without a Studio session and persist an idempotent completion', async ({ request }) => {
  const owner = await seedActiveAccount(admin(), 'Worker API owner');
  const store = await seedStore(admin(), 'Worker API store', owner.userId);
  const workerKey = `e2e-${randomBytes(6).toString('hex')}`;
  const issued = await withDatabase((db) => provisionWorker(db, admin(), { workerKey, host: 'e2e-host', version: '1.0.0' }));
  const prefix = '/api/worker/v2';
  const headers = { authorization: `Bearer ${issued.token}`, 'x-contract-version': '2' };
  const registration = await validated<components['schemas']['RegisterResponse']>(await request.post(`${prefix}/register`, { headers, data: { workerKey, host: 'e2e-host', version: '1.0.0', accounts: [{ accountKey: 'chatgpt-e2e', provider: 'chatgpt', channel: 'browser', jobTypes: ['listing_content'], installedSkills: [{ slug: workerKey, version: '1.0.0' }] }] } }), 'RegisterResponse', 200);
  const accountId = registration.accounts[0]!.accountId;
  const jobId = newId();
  await withDatabase(async (db) => {
    await db.update(providerAccounts).set({ sessionExpiresAt: new Date(Date.now() + 3600_000) }).where(eq(providerAccounts.id, accountId));
    await db.insert(generationJobs).values({ id: jobId, storeId: store.storeId, requesterId: owner.userId, type: 'listing_content', provider: 'chatgpt', prompt: 'Write a poster listing.', requiredProviderSkills: [{ slug: workerKey, version: '1.0.0' }], params: { locale: 'en', niche: 'wall art', productType: 'poster', context: 'Mountain poster' } });
  });
  const claim = await validated<components['schemas']['ClaimResponse']>(await request.post(`${prefix}/claim`, { headers, data: { workerId: issued.workerId, accountId } }), 'ClaimResponse', 200);
  expect(claim.job.id).toBe(jobId);
  await validated(await request.post(`${prefix}/jobs/${jobId}/heartbeat`, { headers, data: { leaseToken: claim.job.leaseToken } }), 'HeartbeatResponse', 200);
  const body = { leaseToken: claim.job.leaseToken, payload: { title: 'Mountain wall art', description: 'A mountain poster for the home.', tags: ['mountain', 'poster', 'wall art'], seoTitle: 'Mountain poster', seoDescription: 'Mountain wall art for the home.', urlHandle: 'mountain-wall-art' } };
  const completionHeaders = { ...headers, 'idempotency-key': `e2e-${jobId}` };
  const first = await validated(await request.post(`${prefix}/jobs/${jobId}/complete`, { headers: completionHeaders, data: body }), 'CompleteResponse', 200);
  const second = await validated(await request.post(`${prefix}/jobs/${jobId}/complete`, { headers: completionHeaders, data: body }), 'CompleteResponse', 200);
  expect(second).toEqual(first);
  await withDatabase(async (db) => {
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    expect(job!.status).toBe('completed');
    expect(job!.resultPayload).toEqual(body.payload);
    expect(await db.select().from(workerResults).where(eq(workerResults.jobId, jobId))).toHaveLength(0);
    await revokeWorker(db, admin(), issued.workerId);
  });
  await validated(await request.post(`${prefix}/claim`, { headers, data: { workerId: issued.workerId, accountId } }), 'Problem', 401);
  await validated(await request.post(`${prefix}/claim`, { data: {} }), 'Problem', 426);
});
