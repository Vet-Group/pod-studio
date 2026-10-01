import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz, updatedAt } from './columns';
import { stores } from './stores';
import { users } from './users';
import { designs } from './designs';
import { assets } from './assets';
import { providerAccounts, type JobType, type ProviderSkill } from './provider-accounts';
import { workers } from './workers';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type JobPriority = 'interactive' | 'normal' | 'bulk';
export type ErrorClass = 'account_rate_limited' | 'account_session_expired' | 'account_unavailable' | 'provider_refused' | 'input_invalid' | 'transient' | 'cancelled';

export const generationJobs = pgTable('generation_jobs', {
  id: id(),
  storeId: text('store_id').notNull().references(() => stores.id, { onDelete: 'cascade' }),
  requesterId: text('requester_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  type: text('type').$type<JobType>().notNull(),
  provider: text('provider').notNull(),
  priority: text('priority').$type<JobPriority>().notNull().default('normal'),
  requiredProviderSkills: jsonb('required_provider_skills').$type<ProviderSkill[]>().notNull().default([]),
  designId: text('design_id').references(() => designs.id, { onDelete: 'set null' }),
  assetId: text('asset_id').references(() => assets.id, { onDelete: 'set null' }),
  status: text('status').$type<JobStatus>().notNull().default('queued'),
  accountId: text('account_id').references(() => providerAccounts.id, { onDelete: 'set null' }),
  workerId: text('worker_id').references(() => workers.id, { onDelete: 'set null' }),
  leaseToken: text('lease_token'),
  leaseExpiresAt: timestamptz('lease_expires_at'),
  attempt: integer('attempt').notNull().default(0),
  accountRequeues: integer('account_requeues').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  errorClass: text('error_class').$type<ErrorClass>(),
  failureReason: text('failure_reason'),
  workerMessage: text('worker_message'),
  availableAt: timestamptz('available_at').notNull().defaultNow(),
  cancelRequested: boolean('cancel_requested').notNull().default(false),
  // Native bigint preserves exact sequence values beyond Number.MAX_SAFE_INTEGER.
  dispatchOrder: bigint('dispatch_order', { mode: 'bigint' }).notNull().default(sql`0`),
  finishedAt: timestamptz('finished_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('generation_jobs_status_priority_available_at_idx').on(t.status, t.priority, t.availableAt),
  index('generation_jobs_claimable_idx').on(t.provider, t.availableAt).where(sql`${t.status} = 'queued' and ${t.leaseToken} is null and ${t.cancelRequested} = false`),
  index('generation_jobs_status_lease_expires_at_idx').on(t.status, t.leaseExpiresAt),
  index('generation_jobs_account_id_status_idx').on(t.accountId, t.status),
]);
