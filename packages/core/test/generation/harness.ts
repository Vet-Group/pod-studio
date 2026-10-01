import { afterEach } from 'vitest';
import { createDatabase, migrateDatabase, newId, generationJobs, providerAccounts, workers, users, stores, storeMembers, type Database } from '@pod-studio/db';
import { createTestDatabase } from '../../../../tests/support/db';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
let age = 0;
export const now = new Date('2026-10-02T00:00:00Z');
export const owner = { userId: 'requester_owner', role: 'member' as const };
export const other = { userId: 'requester_other', role: 'member' as const };
export const A = 'store_aaa';
export const B = 'store_bbb';
export async function harness() {
  const test = await createTestDatabase();
  cleanup.push(() => test.drop());
  await migrateDatabase(test.connection);
  const handle = createDatabase(test.connection, { max: 20 });
  cleanup.push(() => handle.close());
  const db = handle.db;
  age = 0;
  await db.insert(users).values([owner, other].map((p) => ({ id: p.userId, name: p.userId, email: `${p.userId}@example.test` })));
  await db.insert(stores).values([A, B].map((id) => ({ id, name: id, domain: `${id}.myshopify.com` })));
  await db.insert(storeMembers).values([A, B].flatMap((storeId) => [owner, other].map((p) => ({ storeId, userId: p.userId, role: p.userId === owner.userId ? 'owner' : 'seller', permissions: ['store.view', 'content.generate', 'analysis.run'] }))));
  const workerId = newId();
  await db.insert(workers).values({ id: workerId, workerKey: workerId, host: 'test-host', version: 'test' });
  const accountId = await account(db, workerId);
  return { db, client: handle.client, workerId, accountId };
}
export async function account(db: Database, workerId: string, overrides: Partial<typeof providerAccounts.$inferInsert> = {}) {
  const id = newId();
  await db.insert(providerAccounts).values({ id, workerId, accountKey: id, provider: 'chatgpt', channel: 'browser', jobTypes: ['generate'], maxConcurrency: 16, sessionExpiresAt: new Date(now.getTime() + 3600_000), ...overrides });
  return id;
}
export async function jobs(db: Database, count: number, overrides: Partial<typeof generationJobs.$inferInsert> = {}) {
  const rows = Array.from({ length: count }, () => ({ id: newId(), storeId: A, requesterId: owner.userId, type: 'generate' as const, provider: 'chatgpt', availableAt: now, createdAt: new Date(now.getTime() - 1000_000 + age++), ...overrides }));
  return db.insert(generationJobs).values(rows).returning();
}
