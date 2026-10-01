import { sql } from 'drizzle-orm';
import { foreignKey, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt } from './columns';
import { stores } from './stores';

export interface ProductOption {
  name: string;
  values: string[];
}

export const productTypes = pgTable(
  'product_types',
  {
    id: id(),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    options: jsonb('options')
      .$type<ProductOption[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    currency: text('currency').notNull().default('USD'),
    revision: integer('revision').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('product_types_store_id_name_unique').on(t.storeId, sql`lower(${t.name})`),
    uniqueIndex('product_types_store_id_id_unique').on(t.storeId, t.id),
  ],
);

/** Each row is exactly one variant, never an option-combination generator. */
export const pricingRules = pgTable(
  'pricing_rules',
  {
    id: id(),
    storeId: text('store_id').notNull(),
    productTypeId: text('product_type_id').notNull(),
    optionValues: jsonb('option_values')
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    priceMinor: integer('price_minor').notNull(),
    excludedMarkets: jsonb('excluded_markets')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    sortOrder: integer('sort_order').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.storeId, t.productTypeId],
      foreignColumns: [productTypes.storeId, productTypes.id],
    }).onDelete('restrict'),
    index('pricing_rules_product_type_id_sort_order_idx').on(t.productTypeId, t.sortOrder),
  ],
);
