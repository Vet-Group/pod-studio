import { sql } from 'drizzle-orm';
import { index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt } from './columns';
import { stores } from './stores';
import { users } from './users';

/**
 * A user's access to one store (ADR 0002): a preset `role` plus the permission list it filled, which
 * the owner may then toggle per member. Role and permission names are checked in packages/core
 * (PRD §4: no enums or CHECK constraints in the database).
 *
 * - One row per store and user.
 * - Exactly one owner per store is enforced here as well as in the app: the partial unique index
 *   makes two racing transactions that both try to add an owner fail instead of both succeeding.
 * - Removing a store or a user removes the membership; history stays in audit_log.
 */
export const storeMembers = pgTable(
  'store_members',
  {
    id: id(),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    permissions: text('permissions')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Who added or last changed this membership; null for rows created by a system job. */
    grantedBy: text('granted_by').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('store_members_store_user_unique').on(t.storeId, t.userId),
    uniqueIndex('store_members_one_owner').on(t.storeId).where(sql`${t.role} = 'owner'`),
    index('store_members_user_id_idx').on(t.userId),
  ],
);
