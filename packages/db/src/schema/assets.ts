import { bigint, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import { stores } from './stores';
import { users } from './users';

/** Only verified immutable objects are assets; uploads stay in a separate staging table. */
export const assets = pgTable('assets', {
  id: id(),
  storeId: text('store_id').notNull().references(() => stores.id, { onDelete: 'cascade' }),
  sha256: text('sha256').notNull(),
  storageKey: text('storage_key').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('assets_store_id_sha256_unique').on(t.storeId, t.sha256), uniqueIndex('assets_storage_key_unique').on(t.storageKey)]);

export const assetUploads = pgTable('asset_uploads', {
  id: id(),
  storeId: text('store_id').notNull().references(() => stores.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  storageKey: text('storage_key').notNull(),
  sha256: text('sha256').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  status: text('status').$type<'pending' | 'finalized' | 'rejected'>().notNull().default('pending'),
  assetId: text('asset_id').references(() => assets.id, { onDelete: 'set null' }),
  expiresAt: timestamptz('expires_at').notNull(),
  createdAt: createdAt(),
}, (t) => [index('asset_uploads_store_id_idx').on(t.storeId), uniqueIndex('asset_uploads_storage_key_unique').on(t.storageKey)]);
