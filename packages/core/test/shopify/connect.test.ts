import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { auditLog, createDatabase, eq, migrateDatabase, storeMembers, stores, users, shopifyConnections, type Database } from '@pod-studio/db';
import { createTestDatabase } from '../../../../tests/support/db';
import { startShopifyStub } from '../../../../tests/support/shopify-stub';
import { getShopifyConnection, saveShopifyConnection, rotateShopifyConnection, removeShopifyConnection, testShopifyConnection } from '../../src/shopify/connect';
import { decryptSecret, parseEncryptionKeys } from '../../src/shopify/crypto';
import type { Principal } from '../../src/access/can';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
const owner: Principal = { userId: 'owner_test_01', role: 'member' };
const member: Principal = { userId: 'member_test_01', role: 'member' };
const editor: Principal = { userId: 'editor_test_01', role: 'member' };
const admin: Principal = { userId: 'admin_test_01', role: 'admin' };
const storeId = 'store_test_01';
const secrets = { clientId: 'public-app-id', clientSecret: 'private_client_secret', accessToken: 'shpat_private_token' };
const key1 = randomBytes(32).toString('base64');
const key2 = randomBytes(32).toString('base64');
const keys = parseEncryptionKeys(`v1:${key1},v2:${key2}`, 'v1');

async function harness(): Promise<Database> {
  const test = await createTestDatabase(); cleanup.push(() => test.drop());
  await migrateDatabase(test.connection);
  const handle = createDatabase(test.connection); cleanup.push(() => handle.close());
  const db = handle.db;
  await db.insert(users).values([owner, member, editor, admin].map((p) => ({ id: p.userId, name: p.userId, email: `${p.userId}@example.test`, role: p.role })));
  await db.insert(stores).values({ id: storeId, name: 'Demo', domain: 'demo.myshopify.com' });
  await db.insert(storeMembers).values([
    { storeId, userId: owner.userId, role: 'owner', permissions: ['store.settings'] },
    { storeId, userId: editor.userId, role: 'co_leader', permissions: ['store.settings'] },
    { storeId, userId: member.userId, role: 'seller', permissions: ['store.view'] },
  ]);
  return db;
}

describe('Shopify connection permissions and persistence', () => {
  it('encrypts credentials at rest, masks responses and audits save, rotation and removal', async () => {
    const db = await harness();
    await saveShopifyConnection(db, owner, storeId, secrets, keys);
    const before = (await db.select().from(shopifyConnections))[0]!;
    expect(decryptSecret(before.clientSecretEncrypted, `${storeId}:clientSecret`, keys)).toBe(secrets.clientSecret);
    expect(decryptSecret(before.accessTokenEncrypted, `${storeId}:accessToken`, keys)).toBe(secrets.accessToken);
    expect(await getShopifyConnection(db, member, storeId)).toMatchObject({ configured: true, canEdit: false, status: 'untested' });
    await rotateShopifyConnection(db, editor, storeId, parseEncryptionKeys(`v1:${key1},v2:${key2}`, 'v2'));
    const after = (await db.select().from(shopifyConnections))[0]!;
    expect(after.clientSecretEncrypted).toMatch(/^v2\./);
    expect(after.accessTokenEncrypted).toMatch(/^v2\./);
    expect(after.clientSecretEncrypted).not.toBe(before.clientSecretEncrypted);
    expect(decryptSecret(after.accessTokenEncrypted, `${storeId}:accessToken`, parseEncryptionKeys(`v2:${key2}`, 'v2'))).toBe(secrets.accessToken);
    const safe = JSON.stringify({ before, after, status: await getShopifyConnection(db, owner, storeId), audit: await db.select().from(auditLog) });
    for (const secret of [secrets.clientSecret, secrets.accessToken]) expect(safe).not.toContain(secret);
    await removeShopifyConnection(db, owner, storeId);
    expect(await db.select().from(shopifyConnections)).toHaveLength(0);
    expect((await db.select().from(auditLog)).map((r) => r.action)).toEqual(['shopify.credentials.saved', 'shopify.credentials.rotated', 'shopify.credentials.removed']);
  });
  it('requires membership for status and store.settings for every sensitive operation, with no admin bypass', async () => {
    const db = await harness();
    for (const actor of [member, admin]) {
      await expect(saveShopifyConnection(db, actor, storeId, secrets, keys)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(rotateShopifyConnection(db, actor, storeId, keys)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(removeShopifyConnection(db, actor, storeId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(testShopifyConnection(db, actor, storeId, { keys })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await expect(getShopifyConnection(db, admin, storeId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await saveShopifyConnection(db, editor, storeId, secrets, keys);
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });
  it('tests through the local stub and records safe success/failure audits without returning remote content', async () => {
    const db = await harness();
    await saveShopifyConnection(db, owner, storeId, secrets, keys);
    const stub = await startShopifyStub(); cleanup.push(stub.close);
    expect(await testShopifyConnection(db, owner, storeId, { keys, endpoint: stub.url, environment: 'test' })).toMatchObject({ status: 'connected' });
    const failing = await startShopifyStub([{ status: 401, body: { errors: secrets.accessToken } }]); cleanup.push(failing.close);
    expect(await testShopifyConnection(db, owner, storeId, { keys, endpoint: failing.url, environment: 'test' })).toMatchObject({ status: 'failed' });
    expect(await getShopifyConnection(db, member, storeId)).toMatchObject({ status: 'failed', configured: true });
    const audit = await db.select().from(auditLog);
    expect(audit.filter((r) => r.action === 'shopify.connection.tested')).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain(secrets.accessToken);
    expect(JSON.stringify(audit)).not.toContain(secrets.clientSecret);
    await saveShopifyConnection(db, owner, storeId, { ...secrets, accessToken: 'replacement' }, keys);
    expect(await getShopifyConnection(db, owner, storeId)).toMatchObject({ status: 'untested', testedAt: null });
  });
  it('rejects invalid inputs without echoing secrets and keeps writes atomic', async () => {
    const db = await harness();
    await expect(saveShopifyConnection(db, owner, storeId, { ...secrets, clientSecret: '' }, keys)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await db.select().from(shopifyConnections).where(eq(shopifyConnections.storeId, storeId))).toHaveLength(0);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });
});
