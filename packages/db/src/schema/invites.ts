import { sql } from 'drizzle-orm';
import { index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import { stores } from './stores';
import { users, type GlobalRole } from './users';

/**
 * Single-use invite links (ADR 0002). Only the SHA-256 hash of the token is stored; the plain token is
 * shown once to whoever created the invite. An invite is usable while `accepted_at`, `revoked_at` are
 * null and `expires_at` is in the future. `store_id`, `store_role` and `permissions` describe the store
 * access the invite grants; store memberships themselves arrive with P1-04.
 */
export const invites = pgTable(
  'invites',
  {
    id: id(),
    // Normalized (trimmed, lower-case) email the invite is bound to.
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull(),
    globalRole: text('global_role').$type<GlobalRole>().notNull().default('member'),
    storeId: text('store_id').references(() => stores.id, { onDelete: 'restrict' }),
    storeRole: text('store_role'),
    permissions: text('permissions')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    invitedBy: text('invited_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    expiresAt: timestamptz('expires_at').notNull(),
    acceptedAt: timestamptz('accepted_at'),
    acceptedBy: text('accepted_by').references(() => users.id, { onDelete: 'restrict' }),
    revokedAt: timestamptz('revoked_at'),
    revokedBy: text('revoked_by').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('invites_token_hash_unique').on(t.tokenHash),
    index('invites_email_idx').on(t.email),
    index('invites_store_id_idx').on(t.storeId),
    index('invites_invited_by_idx').on(t.invitedBy),
  ],
);
