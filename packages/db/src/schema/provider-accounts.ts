import { index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz, updatedAt } from './columns';
import { workers } from './workers';

export type JobType = 'analyze' | 'generate' | 'redesign' | 'seo' | 'mockup' | 'listing_content' | 'product_analysis';
export type AccountState = 'available' | 'cooldown' | 'session_expired' | 'disabled' | 'busy' | 'offline';
export interface ProviderSkill { slug: string; version?: string }

/** Account metadata only. Credentials stay on worker machines. */
export const providerAccounts = pgTable('provider_accounts', {
  id: id(),
  workerId: text('worker_id').notNull().references(() => workers.id, { onDelete: 'cascade' }),
  accountKey: text('account_key').notNull(),
  provider: text('provider').notNull(),
  channel: text('channel').$type<'browser' | 'api'>().notNull(),
  jobTypes: text('job_types').array().$type<JobType[]>().notNull().default([]),
  installedSkills: jsonb('installed_skills').$type<ProviderSkill[]>().notNull().default([]),
  maxConcurrency: integer('max_concurrency').notNull().default(1),
  state: text('state').$type<AccountState>().notNull().default('available'),
  cooldownUntil: timestamptz('cooldown_until'),
  sessionExpiresAt: timestamptz('session_expires_at'),
  lastHealthyAt: timestamptz('last_healthy_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('provider_accounts_worker_id_account_key_unique').on(t.workerId, t.accountKey), index('provider_accounts_state_idx').on(t.state)]);
