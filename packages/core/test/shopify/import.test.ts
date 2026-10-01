import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  asc,
  auditLog,
  createDatabase,
  eq,
  importRuns,
  migrateDatabase,
  products,
  storeMembers,
  storeProducts,
  stores,
  users,
  variants,
  shopifyConnections,
} from '@pod-studio/db';
import { createTestDatabase } from '../../../../tests/support/db';
import { startShopifyStub } from '../../../../tests/support/shopify-stub';
import { ROLE_PRESETS, createProductType, savePriceTable, type Principal } from '../../src';
import { saveShopifyConnection } from '../../src/shopify/connect';
import { parseEncryptionKeys } from '../../src/shopify/crypto';
import { startShopifyImport, runShopifyImport, listShopifyImports } from '../../src/shopify/import';
import { resyncVariants, variantOptionKey } from '../../src/catalog/resync';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
const owner: Principal = { userId: 'import_owner', role: 'member' };
const viewer: Principal = { userId: 'import_viewer', role: 'member' };
const admin: Principal = { userId: 'import_admin', role: 'admin' };
const storeId = 'import_store';
const keys = parseEncryptionKeys(`v1:${randomBytes(32).toString('base64')}`, 'v1');
const price = (Size: string, amount = '12.50') => ({ optionValues: { Size }, price: amount, excludedMarkets: ['DE'] });
async function harness() {
  const test = await createTestDatabase();
  cleanup.push(() => test.drop());
  await migrateDatabase(test.connection);
  const handle = createDatabase(test.connection, { max: 5 });
  cleanup.push(() => handle.close());
  const db = handle.db;
  await db.insert(users).values(
    [owner, viewer, admin].map((p) => ({
      id: p.userId,
      name: p.userId,
      email: `${p.userId}@import.test`,
      role: p.role,
    })),
  );
  await db.insert(stores).values({ id: storeId, name: 'Import', domain: 'import.myshopify.com' });
  await db.insert(storeMembers).values([
    { storeId, userId: owner.userId, role: 'owner', permissions: [...ROLE_PRESETS.owner] },
    { storeId, userId: viewer.userId, role: 'viewer', permissions: ['store.view'] },
  ]);
  const type = await createProductType(db, owner, storeId, {
    name: 'Poster',
    currency: 'USD',
    options: [{ name: 'Size', values: ['S', 'M', 'L'] }],
  });
  await savePriceTable(db, owner, storeId, type.id, { revision: 0, rows: [price('S'), price('M')] });
  await saveShopifyConnection(
    db,
    owner,
    storeId,
    { clientId: 'stub', clientSecret: 'private_secret', accessToken: 'private_token' },
    keys,
  );
  const stub = await startShopifyStub();
  cleanup.push(() => stub.close());
  return { db, type, deps: { keys, endpoint: stub.url, environment: 'test' } };
}

describe('Shopify import and price-table resync', () => {
  it('imports paginated filtered products twice without duplicates, with current prices and no upstream SKU', async () => {
    const { db, type, deps } = await harness();
    const first = await startShopifyImport(db, owner, storeId, type.id);
    await runShopifyImport(db, first.id, deps);
    const second = await startShopifyImport(db, owner, storeId, type.id);
    await runShopifyImport(db, second.id, deps);
    expect(await db.select().from(products)).toHaveLength(2);
    expect(await db.select().from(storeProducts)).toHaveLength(2);
    const rows = await db.select().from(variants).orderBy(asc(variants.position));
    expect(rows).toHaveLength(4);
    expect(rows.every((v) => v.sku === null && v.inventoryQty === 100 && v.priceMinor === 1250)).toBe(true);
    expect(rows.map((v) => v.optionValues.Size)).toEqual(['S', 'S', 'M', 'M']);
    expect((await db.select().from(storeProducts)).every((p) => p.status === 'pushed' && p.checksum === null)).toBe(
      true,
    );
    expect((await db.select().from(products))[0]).toMatchObject({
      vendor: 'Stub vendor',
      tags: ['imported'],
      descriptionHtml: '<p>Shopify description</p>',
      status: 'active',
    });
    const runs = await db.select().from(importRuns).orderBy(asc(importRuns.createdAt));
    expect(runs[0]).toMatchObject({ status: 'done', imported: 2, skipped: 0, totalRows: 3 });
    expect(runs[0]!.errors).toHaveLength(1);
    expect(runs[1]).toMatchObject({ status: 'done', imported: 0, skipped: 2 });
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'shopify.import.started'))).toHaveLength(2);
    expect(JSON.stringify(runs)).not.toContain('private_token');
  });

  it('rejects concurrent starts and concurrent workers process a run only once', async () => {
    const { db, type, deps } = await harness();
    const starts = await Promise.allSettled([
      startShopifyImport(db, owner, storeId, type.id),
      startShopifyImport(db, owner, storeId, type.id),
    ]);
    expect(starts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(starts.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'IMPORT_ACTIVE' } });
    const [run] = await db.select().from(importRuns);
    await Promise.all([runShopifyImport(db, run!.id, deps), runShopifyImport(db, run!.id, deps)]);
    expect(await db.select().from(products)).toHaveLength(2);
    expect(await db.select().from(storeProducts)).toHaveLength(2);
    await runShopifyImport(db, run!.id, deps);
    expect((await db.select().from(importRuns))[0]).toMatchObject({ status: 'done', imported: 2, skipped: 0 });
  });

  it('includes and bounds manual catalog products for local resync with an accurate total', async () => {
    const { db, type } = await harness();
    await db
      .insert(products)
      .values(
        Array.from({ length: 51 }, (_, index) => ({ storeId, productTypeId: type.id, title: `Listing ${index}` })),
      );
    const state = await listShopifyImports(db, viewer, storeId);
    expect(state.products).toHaveLength(50);
    expect(state).toMatchObject({ productCount: 51, canEdit: false, connected: true });
    expect(JSON.stringify(state)).not.toContain('private_token');
  });

  it('keeps CSV and sheet runs out of Shopify progress and busy state', async () => {
    const { db, type } = await harness();
    await db.insert(importRuns).values([
      { storeId, source: 'csv', ref: 'local.csv' },
      { storeId, source: 'sheet', ref: 'sheet-ref' },
    ]);
    expect((await listShopifyImports(db, owner, storeId)).runs).toEqual([]);
    const run = await startShopifyImport(db, owner, storeId, type.id);
    expect((await listShopifyImports(db, owner, storeId)).runs.map((entry) => entry.id)).toEqual([run.id]);
  });

  it('uses explicit product.edit grants, not global admin rights or store.settings', async () => {
    const { db, type } = await harness();
    await db
      .insert(storeMembers)
      .values({ storeId, userId: admin.userId, role: 'viewer', permissions: ['store.view'] });
    await expect(startShopifyImport(db, admin, storeId, type.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await db
      .update(storeMembers)
      .set({ role: 'seller', permissions: ['store.view', 'product.edit'] })
      .where(eq(storeMembers.userId, viewer.userId));
    const run = await startShopifyImport(db, viewer, storeId, type.id);
    expect(run).toMatchObject({ status: 'queued', requestedBy: viewer.userId });
  });

  it('enforces one active Shopify import across product types', async () => {
    const { db, type, deps } = await harness();
    const otherType = await createProductType(db, owner, storeId, {
      name: 'Mug', currency: 'USD', options: [{ name: 'Size', values: ['S'] }],
    });
    const starts = await Promise.allSettled([
      startShopifyImport(db, owner, storeId, type.id),
      startShopifyImport(db, owner, storeId, otherType.id),
    ]);
    expect(starts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(starts.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'IMPORT_ACTIVE', message: 'Another Shopify import is already queued or running for this store.' },
    });
    const runs = await db.select().from(importRuns);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    await expect(db.insert(importRuns).values({ storeId, source: 'shopify', ref: otherType.id })).rejects.toMatchObject({ cause: { code: '23505', constraint_name: 'import_runs_store_active_unique' } });
    await runShopifyImport(db, run.id, deps);
    const second = await startShopifyImport(db, owner, storeId, type.id);
    await runShopifyImport(db, second.id, deps);
    expect(await db.select().from(products)).toHaveLength(2);
    expect(await db.select().from(storeProducts)).toHaveLength(2);
    expect(await db.select().from(variants)).toHaveLength(4);
    const finished = await db.select().from(importRuns);
    expect(finished.every((entry) => entry.status === 'done')).toBe(true);
    expect(finished.reduce((sum, entry) => sum + entry.imported, 0)).toBe(2);
    expect(finished.reduce((sum, entry) => sum + entry.skipped, 0)).toBe(2);
  });

  it('maps the database active-run unique violation to the safe public error', async () => {
    const { db, type } = await harness();
    const spy = vi.spyOn(db, 'transaction').mockRejectedValueOnce({ cause: { code: '23505', constraint_name: 'import_runs_store_active_unique' } });
    try {
      await expect(startShopifyImport(db, owner, storeId, type.id)).rejects.toMatchObject({ code: 'IMPORT_ACTIVE', message: 'Another Shopify import is already queued or running for this store.' });
    } finally { spy.mockRestore(); }
  });

  it('fails safely when claim setup rejects before taking a lease', async () => {
    const { db, type, deps } = await harness();
    const run = await startShopifyImport(db, owner, storeId, type.id);
    const spy = vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('raw shpat_claim_secret'));
    await expect(runShopifyImport(db, run.id, deps)).resolves.toBeUndefined();
    spy.mockRestore();
    const [failed] = await db.select().from(importRuns).where(eq(importRuns.id, run.id));
    expect(failed).toMatchObject({ status: 'failed', errors: ['Import stopped. Check Shopify connection and store permissions, then start a new import.'] });
    expect(JSON.stringify(failed)).not.toContain('shpat_claim_secret');
  });

  it('fails safely on undecryptable connection ciphertext', async () => {
    const { db, type, deps } = await harness();
    const run = await startShopifyImport(db, owner, storeId, type.id);
    await db.update(shopifyConnections).set({ accessTokenEncrypted: 'raw shpat_bad_ciphertext' }).where(eq(shopifyConnections.storeId, storeId));
    await expect(runShopifyImport(db, run.id, deps)).resolves.toBeUndefined();
    const [failed] = await db.select().from(importRuns).where(eq(importRuns.id, run.id));
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed!.errors).toEqual(['Import stopped. Check Shopify connection and store permissions, then start a new import.']);
    expect(JSON.stringify(failed)).not.toContain('shpat_bad_ciphertext');
  });

  it.each(['progress', 'failure'])('fences old worker %s after stale takeover', async (resume) => {
    const { db, type, deps } = await harness();
    const run = await startShopifyImport(db, owner, storeId, type.id);
    const originalFetch = globalThis.fetch;
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let first = true;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
      if (first) {
        first = false; entered(); await waiting;
        if (resume === 'failure') throw new Error('raw shpat_old_worker_secret');
      }
      return originalFetch(...args);
    });
    try {
      const oldWorker = runShopifyImport(db, run.id, deps);
      await started;
      const [old] = await db.select().from(importRuns).where(eq(importRuns.id, run.id));
      await db.update(importRuns).set({ startedAt: new Date(0), updatedAt: new Date(0) }).where(eq(importRuns.id, run.id));
      await runShopifyImport(db, run.id, deps);
      const [newOwner] = await db.select().from(importRuns).where(eq(importRuns.id, run.id));
      expect(newOwner!.attemptToken).not.toBe(old!.attemptToken);
      expect(newOwner).toMatchObject({ status: 'done', imported: 2, totalRows: 3, cursor: 'stub:3' });
      const catalog = await db.select().from(products);
      release();
      await oldWorker;
      expect((await db.select().from(importRuns).where(eq(importRuns.id, run.id)))[0]).toEqual(newOwner);
      expect(await db.select().from(products)).toEqual(catalog);
    } finally { release(); spy.mockRestore(); }
  });

  it('rejects cross-store tracking and Shopify import refs at the database boundary', async () => {
    const { db, type } = await harness();
    await db.insert(stores).values({ id: 'other_import_store', name: 'Other', domain: 'other.myshopify.com', apiVersion: '2026-07' });
    const [product] = await db.insert(products).values({ storeId, productTypeId: type.id, title: 'Scoped' }).returning();
    await expect(db.insert(storeProducts).values({ productId: product!.id, storeId: 'other_import_store', shopifyGid: 'gid://shopify/Product/901', status: 'pushed' })).rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(db.insert(importRuns).values({ storeId: 'other_import_store', source: 'shopify', ref: type.id })).rejects.toMatchObject({ cause: { code: '23503' } });
    await db.insert(importRuns).values({ storeId: 'other_import_store', source: 'csv', ref: 'arbitrary.csv' });
  });

  it('never exposes credentials or raw upstream errors in progress or audit data', async () => {
    const { db, type, deps } = await harness();
    const raw = 'upstream raw error shpat_fake_token_12345 private_token';
    const stub = await startShopifyStub([{ status: 401, body: { errors: [{ message: raw }] } }]);
    cleanup.push(() => stub.close());
    const run = await startShopifyImport(db, owner, storeId, type.id);
    await runShopifyImport(db, run.id, { ...deps, endpoint: stub.url });
    const [failed] = await db.select().from(importRuns).where(eq(importRuns.id, run.id));
    expect(failed).toMatchObject({ status: 'failed' });
    const visible = JSON.stringify({ audit: await db.select().from(auditLog), errors: failed!.errors, response: await listShopifyImports(db, owner, storeId) });
    for (const forbidden of [raw, 'shpat_fake_token_12345', 'private_token', 'upstream raw error']) expect(visible).not.toContain(forbidden);
  });

  it('resumes a stale running run from its persisted cursor without recounting committed products', async () => {
    const { db, type, deps } = await harness();
    const run = await startShopifyImport(db, owner, storeId, type.id);
    await runShopifyImport(db, run.id, deps);
    await db
      .update(importRuns)
      .set({
        status: 'running',
        cursor: 'stub:1',
        imported: 1,
        totalRows: 1,
        skipped: 0,
        errors: [],
        startedAt: new Date(0),
        finishedAt: null,
      })
      .where(eq(importRuns.id, run.id));
    await runShopifyImport(db, run.id, deps);
    expect(await db.select().from(products)).toHaveLength(2);
    expect((await db.select().from(importRuns))[0]).toMatchObject({
      status: 'done',
      imported: 1,
      skipped: 1,
      cursor: 'stub:3',
    });
  });

  it('matches by canonical option key, not reordered indexes, preserves IDs and SKU including new rows', async () => {
    const { db, type, deps } = await harness();
    const run = await startShopifyImport(db, owner, storeId, type.id);
    await runShopifyImport(db, run.id, deps);
    const [product] = await db.select().from(products);
    await db.update(variants).set({ sku: 'design-file' }).where(eq(variants.productId, product!.id));
    const before = await db.select().from(variants).where(eq(variants.productId, product!.id));
    await savePriceTable(db, owner, storeId, type.id, {
      revision: 1,
      rows: [price('M', '20.00'), price('S', '15.00'), price('L', '25.00')],
    });
    await resyncVariants(db, owner, storeId, product!.id);
    const after = await db
      .select()
      .from(variants)
      .where(eq(variants.productId, product!.id))
      .orderBy(asc(variants.position));
    expect(after.map((v) => v.optionValues.Size)).toEqual(['M', 'S', 'L']);
    expect(after.map((v) => v.priceMinor)).toEqual([2000, 1500, 2500]);
    for (const old of before) expect(after.find((v) => v.optionValues.Size === old.optionValues.Size)?.id).toBe(old.id);
    expect(after.every((v) => v.sku === 'design-file' && v.excludedMarkets[0] === 'DE')).toBe(true);
    await savePriceTable(db, owner, storeId, type.id, { revision: 2, rows: [price('L')] });
    await resyncVariants(db, owner, storeId, product!.id);
    expect(await db.select().from(variants).where(eq(variants.productId, product!.id))).toHaveLength(1);
    expect(variantOptionKey({ Color: 'Blue', Size: 'M' })).toBe(variantOptionKey({ Size: 'M', Color: 'Blue' }));
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'catalog.variants.resynced'))).toHaveLength(2);
  });

  it('keeps NULL SKU NULL during resync and refuses cross-store or unauthorized access', async () => {
    const { db, type, deps } = await harness();
    for (const actor of [viewer, admin])
      await expect(startShopifyImport(db, actor, storeId, type.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const run = await startShopifyImport(db, owner, storeId, type.id);
    await runShopifyImport(db, run.id, deps);
    const [product] = await db.select().from(products);
    for (const actor of [viewer, admin])
      await expect(resyncVariants(db, actor, storeId, product!.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await resyncVariants(db, owner, storeId, product!.id);
    expect((await db.select().from(variants)).every((v) => v.sku === null)).toBe(true);
    await expect(resyncVariants(db, owner, storeId, 'unknown_product')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const otherType = await createProductType(db, owner, storeId, {
      name: 'Other Poster',
      currency: 'USD',
      options: [{ name: 'Size', values: ['S'] }],
    });
    await expect(startShopifyImport(db, owner, 'unknown_store', otherType.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await db.insert(stores).values({ id: 'second_import_store', name: 'Other', domain: 'other-import.myshopify.com' });
    await db.insert(storeMembers).values({
      storeId: 'second_import_store',
      userId: owner.userId,
      role: 'owner',
      permissions: [...ROLE_PRESETS.owner],
    });
    await expect(startShopifyImport(db, owner, 'second_import_store', type.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const beforeIdor = await db.select().from(variants).where(eq(variants.productId, product!.id));
    const auditsBeforeIdor = await db.select().from(auditLog);
    await expect(resyncVariants(db, owner, 'second_import_store', product!.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await db.select().from(variants).where(eq(variants.productId, product!.id))).toEqual(beforeIdor);
    expect(await db.select().from(auditLog)).toEqual(auditsBeforeIdor);
    await db.delete(storeMembers).where(eq(storeMembers.userId, owner.userId));
    const blocked = await db
      .insert(importRuns)
      .values({ storeId, source: 'shopify', ref: type.id, requestedBy: owner.userId })
      .returning();
    await runShopifyImport(db, blocked[0]!.id, deps);
    expect((await db.select().from(importRuns).where(eq(importRuns.id, blocked[0]!.id)))[0]).toMatchObject({
      status: 'failed',
      imported: 0,
    });
  });
});
