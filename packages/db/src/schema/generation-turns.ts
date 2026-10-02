import { bigint, pgSequence, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt } from './columns';
import { stores } from './stores';
import { users } from './users';
import type { JobPriority } from './generation-jobs';

// PostgreSQL sequences are bigint by default, non-cycling, and independent of job history.
export const generationDispatchOrder = pgSequence('generation_dispatch_order_seq', { cache: 1, cycle: false });

export const generationStoreTurns = pgTable('generation_store_turns', {
  id: id(),
  priority: text('priority').$type<JobPriority>().notNull(),
  storeId: text('store_id').notNull().references(() => stores.id, { onDelete: 'cascade' }),
  lastDispatch: bigint('last_dispatch', { mode: 'bigint' }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('generation_store_turns_key_idx').on(t.priority, t.storeId)]);

export const generationRequesterTurns = pgTable('generation_requester_turns', {
  id: id(),
  priority: text('priority').$type<JobPriority>().notNull(),
  storeId: text('store_id').notNull().references(() => stores.id, { onDelete: 'cascade' }),
  requesterId: text('requester_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  lastDispatch: bigint('last_dispatch', { mode: 'bigint' }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('generation_requester_turns_key_idx').on(t.priority, t.storeId, t.requesterId)]);
