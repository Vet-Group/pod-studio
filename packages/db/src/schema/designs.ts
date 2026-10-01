import { index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt } from './columns';
import { assets } from './assets';
import { stores } from './stores';
import { users } from './users';

export const designs = pgTable('designs', {
  id: id(),
  storeId: text('store_id').notNull().references(() => stores.id, { onDelete: 'cascade' }),
  assetId: text('asset_id').notNull().references(() => assets.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('designs_store_id_idx').on(t.storeId)]);

/** Explicit destination grants. Source ownership never changes and sharing is not transitive. */
export const designShares = pgTable('design_shares', {
  id: id(),
  designId: text('design_id').notNull().references(() => designs.id, { onDelete: 'cascade' }),
  storeId: text('store_id').notNull().references(() => stores.id, { onDelete: 'cascade' }),
  sharedBy: text('shared_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('design_shares_design_id_store_id_unique').on(t.designId, t.storeId), index('design_shares_store_id_idx').on(t.storeId)]);
