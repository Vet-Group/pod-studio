import { sql } from 'drizzle-orm';
import { foreignKey, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz, updatedAt } from './columns';
import { pricingRules, productTypes } from './catalog';
import { stores } from './stores';
import { users } from './users';

export const products = pgTable(
  'products',
  {
    id: id(),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    productTypeId: text('product_type_id').notNull(),
    title: text('title').notNull(),
    descriptionHtml: text('description_html').notNull().default(''),
    vendor: text('vendor').notNull().default(''),
    tags: jsonb('tags')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    handle: text('handle'),
    status: text('status').$type<'draft' | 'active'>().notNull().default('draft'),
    sku: text('sku'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('products_id_store_id_unique').on(t.id, t.storeId),
    foreignKey({
      columns: [t.storeId, t.productTypeId],
      foreignColumns: [productTypes.storeId, productTypes.id],
    }).onDelete('restrict'),
    index('products_store_id_idx').on(t.storeId),
    index('products_product_type_id_idx').on(t.productTypeId),
  ],
);

export const variants = pgTable(
  'variants',
  {
    id: id(),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    priceRowId: text('price_row_id').references(() => pricingRules.id, { onDelete: 'set null' }),
    optionValues: jsonb('option_values')
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    priceMinor: integer('price_minor').notNull(),
    compareAtPriceMinor: integer('compare_at_price_minor'),
    sku: text('sku'),
    excludedMarkets: jsonb('excluded_markets')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    inventoryQty: integer('inventory_qty').notNull().default(100),
    position: integer('position').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('variants_product_id_idx').on(t.productId)],
);

export const storeProducts = pgTable(
  'store_products',
  {
    id: id(),
    productId: text('product_id').notNull(),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    shopifyGid: text('shopify_gid').notNull(),
    handle: text('handle'),
    status: text('status').$type<'pushed' | 'error'>().notNull(),
    checksum: text('checksum'),
    lastError: text('last_error'),
    lastPushedAt: timestamptz('last_pushed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.productId, t.storeId], foreignColumns: [products.id, products.storeId] }).onDelete('cascade'),
    uniqueIndex('store_products_product_id_store_id_unique').on(t.productId, t.storeId),
    uniqueIndex('store_products_store_id_shopify_gid_unique').on(t.storeId, t.shopifyGid),
  ],
);

export const importRuns = pgTable(
  'import_runs',
  {
    id: id(),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    source: text('source').$type<'shopify' | 'sheet' | 'csv'>().notNull(),
    ref: text('ref').notNull(),
    shopifyProductTypeId: text('shopify_product_type_id').generatedAlwaysAs(sql`CASE WHEN source = 'shopify' THEN ref ELSE NULL END`),
    attemptToken: text('attempt_token'),
    status: text('status').$type<'queued' | 'running' | 'done' | 'failed'>().notNull().default('queued'),
    totalRows: integer('total_rows').notNull().default(0),
    imported: integer('imported').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    errors: jsonb('errors')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    cursor: text('cursor'),
    requestedBy: text('requested_by').references(() => users.id, { onDelete: 'set null' }),
    startedAt: timestamptz('started_at'),
    finishedAt: timestamptz('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.storeId, t.shopifyProductTypeId], foreignColumns: [productTypes.storeId, productTypes.id] }).onDelete('restrict'),
    index('import_runs_store_id_ref_idx').on(t.storeId, t.ref),
    uniqueIndex('import_runs_store_active_unique').on(t.storeId, t.source).where(sql`status in ('queued', 'running')`),
  ],
);
