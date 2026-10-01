import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz, updatedAt } from './columns';
import { stores } from './stores';

/** Secrets are versioned AES-256-GCM envelopes, never plaintext. One connection per store. */
export const shopifyConnections = pgTable('shopify_connections', {
  id: id(),
  storeId: text('store_id').notNull().references(() => stores.id, { onDelete: 'cascade' }),
  clientId: text('client_id').notNull(),
  clientSecretEncrypted: text('client_secret_encrypted').notNull(),
  accessTokenEncrypted: text('access_token_encrypted').notNull(),
  status: text('status').notNull().default('untested'),
  testedAt: timestamptz('tested_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [uniqueIndex('shopify_connections_store_id_unique').on(table.storeId)]);
