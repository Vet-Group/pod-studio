import { sql } from 'drizzle-orm';
import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt } from './columns';

/**
 * A Shopify store (PRD §4.1). Credentials (`client_id`, encrypted `client_secret`, access token)
 * arrive with P2-05 in their own table, so a store can exist before it is connected. Membership and
 * ownership live in `store_members`.
 */
export const stores = pgTable(
  'stores',
  {
    id: id(),
    name: text('name').notNull(),
    /** `<shop>.myshopify.com`; the app validates the format and stores it lowercase. */
    domain: text('domain').notNull(),
    apiVersion: text('api_version').notNull().default('2026-07'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // Case-insensitive so `Shop.myshopify.com` cannot be registered twice.
  (t) => [uniqueIndex('stores_domain_unique').on(sql`lower(${t.domain})`)],
);
