import { integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz, updatedAt } from './columns';

export const workers = pgTable('workers', {
  id: id(),
  workerKey: text('worker_key').notNull(),
  host: text('host').notNull(),
  version: text('version').notNull(),
  /** SHA-256 digest of the opaque credential. The raw token is never persisted. */
  tokenHash: text('token_hash'),
  tokenRevokedAt: timestamptz('token_revoked_at'),
  state: text('state').$type<'active' | 'disabled'>().notNull().default('active'),
  lastSeenAt: timestamptz('last_seen_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('workers_worker_key_unique').on(t.workerKey), uniqueIndex('workers_token_hash_unique').on(t.tokenHash)]);

export const workerIdempotency = pgTable('worker_idempotency', {
  id: id(),
  workerId: text('worker_id').notNull().references(() => workers.id, { onDelete: 'cascade' }),
  jobId: text('job_id').notNull(),
  operation: text('operation').notNull(),
  key: text('key').notNull(),
  requestHash: text('request_hash').notNull(),
  status: text('status').notNull(),
  response: text('response'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('worker_idempotency_scope_unique').on(t.workerId, t.jobId, t.key)]);

export const workerUploads = pgTable('worker_uploads', {
  id: id(),
  workerId: text('worker_id').notNull().references(() => workers.id, { onDelete: 'cascade' }),
  jobId: text('job_id').notNull(),
  leaseToken: text('lease_token').notNull(),
  uploadKey: text('upload_key').notNull(),
  storageKey: text('storage_key').notNull(),
  sha256: text('sha256').notNull(),
  contentType: text('content_type').notNull(),
  bytes: integer('bytes').notNull(),
  status: text('status').$type<'pending' | 'verified' | 'deleted'>().notNull().default('pending'),
  expiresAt: timestamptz('expires_at').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('worker_uploads_upload_key_unique').on(t.uploadKey)]);

export const workerCleanup = pgTable('worker_cleanup', {
  id: id(),
  storageKey: text('storage_key').notNull().unique(),
  reason: text('reason').notNull(),
  attempts: integer('attempts').notNull().default(0),
  availableAt: timestamptz('available_at').notNull().defaultNow(),
  completedAt: timestamptz('completed_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const skillVersions = pgTable('skill_versions', {
  id: id(),
  skillId: text('skill_id').notNull(),
  status: text('status').$type<'draft' | 'published' | 'deprecated'>().notNull().default('draft'),
  checksum: text('checksum').notNull(),
  manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull(),
  artifactKey: text('artifact_key'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('skill_versions_skill_checksum_unique').on(t.skillId, t.checksum)]);

/** Immutable output records. Image results reference a verified asset; text results carry payload. */
export const workerResults = pgTable('worker_results', {
  id: id(),
  workerId: text('worker_id').notNull().references(() => workers.id, { onDelete: 'cascade' }),
  jobId: text('job_id').notNull(),
  assetId: text('asset_id'),
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('worker_results_job_asset_unique').on(t.jobId, t.assetId)]);
