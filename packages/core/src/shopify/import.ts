import {
  and,
  count,
  desc,
  eq,
  importRuns,
  newId,
  products,
  shopifyConnections,
  storeProducts,
  users,
  variants,
  type Database,
} from '@pod-studio/db';
import { can, findMembership, type Principal } from '../access';
import { AuthError } from '../auth/errors';
import { writeAudit } from '../audit/log';
import { findProductType } from '../catalog/access';
import { currentPriceRows, lockProductStore, requireProductEdit } from '../catalog/resync';
import { createShopifyClient } from './client';
import { decryptSecret, parseEncryptionKeys, type EncryptionKeys } from './crypto';

export const IMPORT_STALE_MS = 15 * 60 * 1000;
export class ShopifyImportError extends Error {
  constructor(public code: 'IMPORT_ACTIVE' | 'CONNECTION_REQUIRED') {
    super(
      code === 'IMPORT_ACTIVE'
        ? 'Another Shopify import is already queued or running for this store.'
        : 'Connect Shopify before importing products.',
    );
  }
}
export async function startShopifyImport(db: Database, principal: Principal, storeId: string, productTypeId: string) {
  try {
    return await db.transaction(async (tx) => {
      await lockProductStore(tx, principal, storeId);
      await findProductType(tx, storeId, productTypeId);
      const [connection] = await tx
        .select({ id: shopifyConnections.storeId })
        .from(shopifyConnections)
        .where(eq(shopifyConnections.storeId, storeId));
      if (!connection) throw new ShopifyImportError('CONNECTION_REQUIRED');
      const runs = await tx
        .select({ status: importRuns.status })
        .from(importRuns)
        .where(and(eq(importRuns.storeId, storeId), eq(importRuns.source, 'shopify')));
      if (runs.some((r) => r.status === 'queued' || r.status === 'running'))
        throw new ShopifyImportError('IMPORT_ACTIVE');
      const [run] = await tx
        .insert(importRuns)
        .values({ storeId, source: 'shopify', ref: productTypeId, requestedBy: principal.userId })
        .returning();
      await writeAudit(tx, {
        actorUserId: principal.userId,
        storeId,
        action: 'shopify.import.started',
        targetType: 'import_run',
        targetId: run!.id,
        data: { productTypeId },
      });
      return run!;
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause ?? error as { code?: string; constraint_name?: string };
    if (cause.code === '23505' && cause.constraint_name === 'import_runs_store_active_unique')
      throw new ShopifyImportError('IMPORT_ACTIVE');
    throw error;
  }
}
interface ShopifyProduct {
  id: string;
  title: string;
  descriptionHtml: string;
  vendor: string;
  tags: string[];
  seo: { title: string | null; description: string | null };
  handle: string;
  status: string;
}
interface ProductPage {
  products: {
    edges: Array<{ cursor: string; node: ShopifyProduct }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}
const QUERY = `query ImportProducts($query: String!, $after: String) {
  products(first: 50, query: $query, after: $after) {
    edges { cursor node { id title descriptionHtml vendor tags seo { title description } handle status } }
    pageInfo { hasNextPage endCursor }
  }
}`;
export interface ShopifyImportDependencies {
  keys?: EncryptionKeys;
  endpoint?: string;
  environment?: string;
}

/** Rotate an opaque lease on every claim; fence catalog and progress commits by that lease. */
export async function runShopifyImport(db: Database, runId: string, deps: ShopifyImportDependencies = {}) {
  let claim: Awaited<ReturnType<typeof claimRun>> | null = null;
  try {
    claim = await claimRun(db, runId);
    if (!claim) return;
    await executeClaimedImport(db, runId, claim, deps);
  } catch {
    try {
      if (claim) await persistImportFailure(db, runId, claim);
      else await persistUnclaimedFailure(db, runId);
    } catch {
      console.error('Shopify import failure persistence unavailable.');
    }
  }
}

async function persistUnclaimedFailure(db: Database, runId: string) {
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(importRuns).where(eq(importRuns.id, runId)).for('update');
    if (!run || run.source !== 'shopify' || run.status === 'done' || run.status === 'failed') return;
    // A claim error must not fail a newer worker that already acquired a live lease.
    if (run.status === 'running' && run.startedAt && Date.now() - run.startedAt.getTime() < IMPORT_STALE_MS) return;
    await tx.update(importRuns).set({
      status: 'failed', attemptToken: newId(), finishedAt: new Date(), updatedAt: new Date(),
      errors: [...run.errors, 'Import stopped. Check Shopify connection and store permissions, then start a new import.'],
    }).where(eq(importRuns.id, runId));
    await writeAudit(tx, {
      actorUserId: run.requestedBy, storeId: run.storeId,
      action: 'shopify.import.failed', targetType: 'import_run', targetId: runId,
    });
  });
}

async function claimRun(db: Database, runId: string) {
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(importRuns).where(eq(importRuns.id, runId)).for('update');
    if (!run || run.source !== 'shopify' || run.status === 'done' || run.status === 'failed') return null;
    if (run.status === 'running' && run.startedAt && Date.now() - run.startedAt.getTime() < IMPORT_STALE_MS)
      return null;
    const lease = new Date();
    const attemptToken = newId();
    await tx
      .update(importRuns)
      .set({ status: 'running', attemptToken, startedAt: lease, finishedAt: null, updatedAt: lease })
      .where(eq(importRuns.id, runId));
    return { ...run, attemptToken };
  });
}

async function executeClaimedImport(
  db: Database,
  runId: string,
  claim: NonNullable<Awaited<ReturnType<typeof claimRun>>>,
  deps: ShopifyImportDependencies,
) {
  const attemptToken = claim.attemptToken;
  const owns = (row: typeof importRuns.$inferSelect) =>
    row.status === 'running' && row.attemptToken === attemptToken;
  const [user] = claim.requestedBy ? await db.select().from(users).where(eq(users.id, claim.requestedBy)) : [];
  if (!user || user.banned || user.mustChangePassword) throw new AuthError('FORBIDDEN');
  const actor: Principal = { userId: user.id, role: user.role };
  await requireProductEdit(db, actor, claim.storeId);
  const [connection] = await db
    .select()
    .from(shopifyConnections)
    .where(eq(shopifyConnections.storeId, claim.storeId));
  if (!connection) throw new ShopifyImportError('CONNECTION_REQUIRED');
  const store = await db.transaction((tx) => lockProductStore(tx, actor, claim.storeId));
  const type = await findProductType(db, claim.storeId, claim.ref);
  const keys = deps.keys ?? parseEncryptionKeys();
  const client = createShopifyClient({
    domain: store.domain,
    apiVersion: store.apiVersion,
    accessToken: decryptSecret(connection.accessTokenEncrypted, `${claim.storeId}:accessToken`, keys),
    endpoint: deps.endpoint,
    environment: deps.environment,
  });
  let cursor = claim.cursor;
  for (;;) {
    const page: ProductPage = await client.request<ProductPage>(QUERY, {
      query: `product_type:${JSON.stringify(type.name)}`,
      after: cursor,
    });
    if (!Array.isArray(page.products?.edges)) throw new Error('Invalid product page.');
    for (const edge of page.products.edges) {
      if (typeof edge.cursor !== 'string' || !edge.cursor || edge.cursor === cursor)
        throw new Error('Invalid import cursor.');
      const result = await db.transaction(async (tx) => {
        // Same store lock as permission/price-table writers, never held during network calls.
        await lockProductStore(tx, actor, claim.storeId);
        const [run] = await tx.select().from(importRuns).where(eq(importRuns.id, runId)).for('update');
        if (!run || !owns(run)) return false;
        let imported = 0,
          skipped = 0;
        const errors = [...run.errors];
        try {
          // Nested transaction is a savepoint: a bad product rolls back without losing the run.
          await tx.transaction(async (savepoint) => {
            const node = edge.node;
            if (
              !node ||
              !/^gid:\/\/shopify\/Product\/\d+$/.test(node.id) ||
              !node.title?.trim() ||
              !['ACTIVE', 'DRAFT', 'ARCHIVED'].includes(node.status) ||
              !Array.isArray(node.tags)
            )
              throw new Error('Invalid product.');
            const [tracked] = await savepoint
              .select({ id: storeProducts.id })
              .from(storeProducts)
              .where(and(eq(storeProducts.storeId, claim.storeId), eq(storeProducts.shopifyGid, node.id)));
            if (tracked) {
              skipped = 1;
              return;
            }
            const rows = await currentPriceRows(savepoint, claim.storeId, claim.ref);
            const productId = newId();
            await savepoint.insert(products).values({
              id: productId,
              storeId: claim.storeId,
              productTypeId: claim.ref,
              title: node.title,
              descriptionHtml: node.descriptionHtml,
              vendor: node.vendor,
              tags: node.tags,
              seoTitle: node.seo?.title,
              seoDescription: node.seo?.description,
              handle: node.handle,
              status: node.status === 'ACTIVE' ? 'active' : 'draft',
            });
            const trackedRow = await savepoint
              .insert(storeProducts)
              .values({
                productId,
                storeId: claim.storeId,
                shopifyGid: node.id,
                handle: node.handle,
                status: 'pushed',
                checksum: null,
                lastPushedAt: new Date(),
              })
              .onConflictDoNothing({ target: [storeProducts.storeId, storeProducts.shopifyGid] })
              .returning({ id: storeProducts.id });
            if (!trackedRow.length) {
              await savepoint.delete(products).where(eq(products.id, productId));
              skipped = 1;
              return;
            }
            if (rows.length)
              await savepoint.insert(variants).values(
                rows.map((row) => ({
                  productId,
                  priceRowId: row.id,
                  optionValues: row.optionValues,
                  priceMinor: row.priceMinor,
                  excludedMarkets: row.excludedMarkets,
                  position: row.sortOrder,
                  sku: null,
                  inventoryQty: 100,
                })),
              );
            imported = 1;
          });
        } catch {
          imported = 0;
          skipped = 0;
          // Show the numeric ID that appears in Shopify admin product URLs, not the internal GID.
          const numericId = /^gid:\/\/shopify\/Product\/(\d+)$/.exec(edge.node?.id ?? '')?.[1];
          const productRef = numericId
            ? ` Shopify product ID: ${numericId}.`
            : ` Product at cursor was invalid.`;
          errors.push(
            `A Shopify product could not be imported. Check its required title, status and product ID.${productRef}`,
          );
        }
        const heartbeat = new Date();
        await tx
          .update(importRuns)
          .set({
            imported: run.imported + imported,
            skipped: run.skipped + skipped,
            totalRows: run.totalRows + 1,
            errors,
            cursor: edge.cursor,
            startedAt: heartbeat,
            updatedAt: heartbeat,
          })
            .where(and(eq(importRuns.id, runId), eq(importRuns.attemptToken, attemptToken)));
        return heartbeat;
      });
      if (!result) return;
      cursor = edge.cursor;
    }
    if (!page.products.pageInfo.hasNextPage) break;
    if (!page.products.edges.length || page.products.pageInfo.endCursor !== cursor)
      throw new Error('Invalid import pagination.');
  }
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(importRuns).where(eq(importRuns.id, runId)).for('update');
    if (!run || !owns(run)) return;
    await tx
      .update(importRuns)
      .set({ status: 'done', finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(importRuns.id, runId), eq(importRuns.attemptToken, attemptToken)));
    await writeAudit(tx, {
      actorUserId: run.requestedBy,
      storeId: claim.storeId,
      action: 'shopify.import.finished',
      targetType: 'import_run',
      targetId: runId,
      data: { imported: run.imported, skipped: run.skipped, errors: run.errors.length },
    });
  });
}

async function persistImportFailure(db: Database, runId: string, claim: NonNullable<Awaited<ReturnType<typeof claimRun>>>) {
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(importRuns).where(eq(importRuns.id, runId)).for('update');
    if (!run || run.status !== 'running' || run.attemptToken !== claim.attemptToken) return;
    await tx
      .update(importRuns)
      .set({
        status: 'failed',
        errors: [
          ...run.errors,
          'Import stopped. Check Shopify connection and store permissions, then start a new import.',
        ],
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(importRuns.id, runId), eq(importRuns.attemptToken, claim.attemptToken)));
    await writeAudit(tx, {
      actorUserId: run.requestedBy,
      storeId: claim.storeId,
      action: 'shopify.import.failed',
      targetType: 'import_run',
      targetId: runId,
    });
  });
}

/** Compact, secret-free authenticated catalog status; never returns connection credentials. */
export async function listShopifyImports(db: Database, principal: Principal, storeId: string) {
  if (!(await can(db, principal, 'store.view', { storeId }))) throw new AuthError('NOT_FOUND');
  const [connection] = await db
    .select({ id: shopifyConnections.storeId })
    .from(shopifyConnections)
    .where(eq(shopifyConnections.storeId, storeId));
  const runs = await db
    .select()
    .from(importRuns)
    .where(and(eq(importRuns.storeId, storeId), eq(importRuns.source, 'shopify')))
    .orderBy(desc(importRuns.createdAt))
    .limit(10);
  const entries = await db
    .select({ id: products.id, title: products.title, productTypeId: products.productTypeId, status: products.status })
    .from(products)
    .where(eq(products.storeId, storeId))
    .orderBy(desc(products.createdAt), desc(products.id))
    .limit(50);
  const [total] = await db.select({ value: count() }).from(products).where(eq(products.storeId, storeId));
  return {
    productCount: total?.value ?? 0,
    connected: !!connection,
    canEdit:
      !!(await findMembership(db, principal.userId, storeId))?.permissions.includes('product.edit') &&
      (await can(db, principal, 'product.edit', { storeId })),
    runs: runs.map((r) => ({
      id: r.id,
      ref: r.ref,
      status: r.status,
      imported: r.imported,
      skipped: r.skipped,
      totalRows: r.totalRows,
      errors: r.errors,
    })),
    products: entries,
  };
}
