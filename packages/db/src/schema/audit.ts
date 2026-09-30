import { index, inet, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, id } from './columns';
import { stores } from './stores';
import { users } from './users';

/** Who performed an action. Checked in the app (PRD §4: no enums or CHECK constraints). */
export const ACTOR_KINDS = ['user', 'agent', 'worker', 'system'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/**
 * Append-only record of permission changes and sensitive actions. P1-04 adds the writer.
 *
 * - `actor_user_id` is required in practice for `user` actors and for agents acting for a user;
 *   workers and system jobs may leave it empty rather than borrow someone's identity.
 * - Foreign keys use `restrict`: a user or store that appears in the log is banned or archived,
 *   never deleted, so history is never rewritten.
 * - Migration 0001 installs triggers that reject UPDATE, DELETE and TRUNCATE.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    actorKind: text('actor_kind').$type<ActorKind>().notNull(),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    storeId: text('store_id').references(() => stores.id, { onDelete: 'restrict' }),
    /** Dotted verb, for example `store.member.grant`. */
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    /** Null for work that did not start from an HTTP request; never invented. */
    requestId: text('request_id'),
    ip: inet('ip'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_log_created_at_idx').on(t.createdAt),
    index('audit_log_actor_user_id_idx').on(t.actorUserId),
    index('audit_log_store_id_idx').on(t.storeId, t.createdAt),
  ],
);
