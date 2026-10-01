import { eq, shopifyConnections, stores, type Database } from '@pod-studio/db';
import { can, findMembership, type Principal } from '../access/can';
import { AuthError } from '../auth/errors';
import { writeAudit, type Executor } from '../audit/log';
import { createShopifyClient } from './client';
import { decryptSecret, encryptSecret, parseEncryptionKeys, type EncryptionKeys } from './crypto';

export type ConnectionStatus = 'unconfigured' | 'untested' | 'connected' | 'failed';
export interface ShopifyConnectionView {
  configured: boolean;
  canEdit: boolean;
  status: ConnectionStatus;
  clientSecret: string | null;
  accessToken: string | null;
  testedAt: string | null;
}
export interface ShopifyCredentials { clientId: string; clientSecret: string; accessToken: string }

/** Status and fixed masks only. Even editors never receive the encrypted or decrypted credentials. */
export async function getShopifyConnection(db: Database, actor: Principal, storeId: string): Promise<ShopifyConnectionView> {
  if (!await findMembership(db, actor.userId, storeId)) throw new AuthError('FORBIDDEN');
  const [row] = await db.select({ status: shopifyConnections.status, testedAt: shopifyConnections.testedAt }).from(shopifyConnections).where(eq(shopifyConnections.storeId, storeId));
  const status = row ? (['untested', 'connected', 'failed'].includes(row.status) ? row.status as ConnectionStatus : 'failed') : 'unconfigured';
  return { configured: !!row, canEdit: await can(db, actor, 'store.settings', { storeId }), status, clientSecret: row ? '••••••••' : null, accessToken: row ? '••••••••' : null, testedAt: row?.testedAt?.toISOString() ?? null };
}

async function requireSettings(db: Executor, actor: Principal, storeId: string) {
  if (!await can(db, actor, 'store.settings', { storeId }) || !await findMembership(db, actor.userId, storeId)) throw new AuthError('FORBIDDEN');
}
async function lockStore(tx: Executor, actor: Principal, storeId: string) {
  const [store] = await tx.select().from(stores).where(eq(stores.id, storeId)).for('update');
  if (!store) throw new AuthError('NOT_FOUND');
  await requireSettings(tx, actor, storeId);
  return store;
}
async function audit(tx: Executor, actor: Principal, storeId: string, action: string, data: Record<string, unknown> = {}) {
  await writeAudit(tx, { actorUserId: actor.userId, action, storeId, targetType: 'shopify_connection', targetId: storeId, data });
}

export async function saveShopifyConnection(db: Database, actor: Principal, storeId: string, input: ShopifyCredentials, keys?: EncryptionKeys): Promise<void> {
  await db.transaction(async (tx) => {
    await lockStore(tx, actor, storeId);
    if (!input || [input.clientId, input.clientSecret, input.accessToken].some((value) => typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\r\n]/.test(value))) throw new AuthError('INVALID_INPUT', 'Enter a client ID, client secret and access token.');
    const keyring = keys ?? parseEncryptionKeys();
    const values = { clientId: input.clientId.trim(), clientSecretEncrypted: encryptSecret(input.clientSecret, `${storeId}:clientSecret`, keyring), accessTokenEncrypted: encryptSecret(input.accessToken, `${storeId}:accessToken`, keyring), status: 'untested', testedAt: null };
    await tx.insert(shopifyConnections).values({ storeId, ...values }).onConflictDoUpdate({ target: shopifyConnections.storeId, set: { ...values, updatedAt: new Date() } });
    await audit(tx, actor, storeId, 'shopify.credentials.saved');
  });
}

/** Keep old keys configured until every connection has been re-encrypted with the active version. */
export async function rotateShopifyConnection(db: Database, actor: Principal, storeId: string, keys?: EncryptionKeys): Promise<void> {
  await db.transaction(async (tx) => {
    await lockStore(tx, actor, storeId);
    const [row] = await tx.select().from(shopifyConnections).where(eq(shopifyConnections.storeId, storeId));
    if (!row) throw new AuthError('NOT_FOUND');
    const keyring = keys ?? parseEncryptionKeys();
    await tx.update(shopifyConnections).set({
      clientSecretEncrypted: encryptSecret(decryptSecret(row.clientSecretEncrypted, `${storeId}:clientSecret`, keyring), `${storeId}:clientSecret`, keyring),
      accessTokenEncrypted: encryptSecret(decryptSecret(row.accessTokenEncrypted, `${storeId}:accessToken`, keyring), `${storeId}:accessToken`, keyring),
    }).where(eq(shopifyConnections.storeId, storeId));
    await audit(tx, actor, storeId, 'shopify.credentials.rotated');
  });
}

export async function removeShopifyConnection(db: Database, actor: Principal, storeId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockStore(tx, actor, storeId);
    await tx.delete(shopifyConnections).where(eq(shopifyConnections.storeId, storeId));
    await audit(tx, actor, storeId, 'shopify.credentials.removed');
  });
}

export async function testShopifyConnection(db: Database, actor: Principal, storeId: string, options: { keys?: EncryptionKeys; endpoint?: string; environment?: string } = {}): Promise<ShopifyConnectionView> {
  // Do not hold the store lock over network/backoff; verify permissions and credential identity again at commit.
  const snapshot = await db.transaction(async (tx) => {
    const store = await lockStore(tx, actor, storeId);
    const [connection] = await tx.select().from(shopifyConnections).where(eq(shopifyConnections.storeId, storeId));
    if (!connection) throw new AuthError('NOT_FOUND');
    return { store, connection };
  });
  let status: ConnectionStatus = 'failed';
  try {
    const accessToken = decryptSecret(snapshot.connection.accessTokenEncrypted, `${storeId}:accessToken`, options.keys ?? parseEncryptionKeys());
    const client = createShopifyClient({ domain: snapshot.store.domain, apiVersion: snapshot.store.apiVersion, accessToken, endpoint: options.endpoint, environment: options.environment });
    const result = await client.request<{ shop?: { myshopifyDomain?: string } }>('query ConnectionTest { shop { myshopifyDomain } }');
    if (result.shop?.myshopifyDomain === snapshot.store.domain) status = 'connected';
  } catch { /* Intentionally discard remote errors and decrypted material. Only a fixed status is persisted. */ }
  await db.transaction(async (tx) => {
    const store = await lockStore(tx, actor, storeId);
    const [current] = await tx.select().from(shopifyConnections).where(eq(shopifyConnections.storeId, storeId));
    if (!current || current.accessTokenEncrypted !== snapshot.connection.accessTokenEncrypted || current.clientSecretEncrypted !== snapshot.connection.clientSecretEncrypted || store.domain !== snapshot.store.domain || store.apiVersion !== snapshot.store.apiVersion) throw new AuthError('INVALID_INPUT', 'The connection changed. Test it again.');
    await tx.update(shopifyConnections).set({ status, testedAt: new Date() }).where(eq(shopifyConnections.storeId, storeId));
    await audit(tx, actor, storeId, 'shopify.connection.tested', { status });
  });
  return getShopifyConnection(db, actor, storeId);
}
