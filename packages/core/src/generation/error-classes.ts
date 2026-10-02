import type { AccountState, ErrorClass, generationJobs, JobStatus } from '@pod-studio/db';

interface ErrorPolicy {
  jobState: JobStatus;
  accountState: AccountState | null;
  countsAttempt: boolean;
  accountError: boolean;
  cooldownSeconds?: number;
}
/** This table mirrors packages/contracts/README.md, including non-counted account errors. */
export const ERROR_CLASSES = {
  account_rate_limited: { jobState: 'queued', accountState: 'cooldown', countsAttempt: false, accountError: true, cooldownSeconds: 60 },
  account_session_expired: { jobState: 'queued', accountState: 'session_expired', countsAttempt: false, accountError: true },
  account_unavailable: { jobState: 'queued', accountState: 'cooldown', countsAttempt: false, accountError: true, cooldownSeconds: 15 },
  provider_refused: { jobState: 'failed', accountState: null, countsAttempt: true, accountError: false },
  input_invalid: { jobState: 'failed', accountState: null, countsAttempt: true, accountError: false },
  transient: { jobState: 'queued', accountState: null, countsAttempt: true, accountError: false },
  cancelled: { jobState: 'cancelled', accountState: null, countsAttempt: false, accountError: false },
} as const satisfies Record<ErrorClass, ErrorPolicy>;

/** Worker text is untrusted: callers must render this as plain text, never HTML or Markdown. */
export function sanitizeWorkerMessage(message: string) {
  if (typeof message !== 'string') throw new GenerationError('validation_failed');
  const clean = message.replace(/\p{Cc}/gu, '').trim();
  const length = Array.from(clean).length;
  if (length < 1 || length > 2000) throw new GenerationError('validation_failed');
  return clean;
}

/** All other worker details are operator-only; never return the raw job row to requesters. */
export function requesterFailureMessage(job: Pick<typeof generationJobs.$inferSelect, 'status' | 'errorClass' | 'workerMessage'>) {
  return job.status === 'failed' && (job.errorClass === 'provider_refused' || job.errorClass === 'input_invalid') ? job.workerMessage : null;
}

export interface RetryOptions { maxAccountRequeues?: number }
export const DEFAULT_MAX_ACCOUNT_REQUEUES = 10;
export function accountRetryLimit(opts: RetryOptions) {
  const limit = opts.maxAccountRequeues ?? DEFAULT_MAX_ACCOUNT_REQUEUES;
  if (!Number.isInteger(limit) || limit < 0) throw new GenerationError('validation_failed');
  return limit;
}

export const GENERATION_ERROR_MESSAGES = {
  job_not_active: 'This job is no longer active.',
  lease_lost: 'This lease is no longer valid.',
  validation_failed: 'The submitted job details are invalid.',
} as const;
export class GenerationError extends Error {
  override readonly name = 'GenerationError';
  constructor(readonly code: keyof typeof GENERATION_ERROR_MESSAGES) { super(GENERATION_ERROR_MESSAGES[code]); }
}

/** Never accept a free-form provider message here: it may contain credentials or prompts. */
export function failureUpdate(job: typeof generationJobs.$inferSelect, errorClass: ErrorClass, now: Date, opts: RetryOptions = {}): Partial<typeof generationJobs.$inferInsert> {
  const policy = ERROR_CLASSES[errorClass];
  const attempt = job.attempt + Number(policy.countsAttempt);
  const accountRequeues = job.accountRequeues + Number(policy.accountError);
  const accountLoop = errorClass !== 'cancelled' && accountRequeues > accountRetryLimit(opts);
  const status = accountLoop || (policy.jobState === 'queued' && attempt >= job.maxAttempts) ? 'failed' : policy.jobState;
  const backoff = errorClass === 'transient' ? Math.min(300, 5 * 2 ** Math.min(attempt - 1, 6)) : 0;
  return {
    status, attempt, accountRequeues, errorClass,
    failureReason: accountLoop ? 'no healthy account available' : status === 'failed' ? (errorClass === 'transient' ? 'maximum attempts reached' : errorClass) : null,
    availableAt: new Date(now.getTime() + backoff * 1000),
    leaseToken: null, leaseExpiresAt: null, accountId: null, workerId: null,
    finishedAt: status === 'queued' ? null : now, updatedAt: now,
  };
}
