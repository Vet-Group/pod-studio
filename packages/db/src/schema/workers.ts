import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz, updatedAt } from './columns';

export const workers = pgTable('workers', {
  id: id(),
  workerKey: text('worker_key').notNull(),
  host: text('host').notNull(),
  version: text('version').notNull(),
  state: text('state').$type<'active' | 'disabled'>().notNull().default('active'),
  lastSeenAt: timestamptz('last_seen_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('workers_worker_key_unique').on(t.workerKey)]);
