# Generation leases (P1-06)

AI generation uses `generation_jobs`, not pg-boss. Workers will access these core functions through
HTTP in P1-07; this task adds no HTTP routes and no Studio page. `apps/jobs` exports a typed,
bounded `reapExpiredLeases(db, now, opts)` sweep. Its pg-boss timer wiring is intentionally deferred.

## Claiming and fairness

- `claimJob(db, { workerId, accountId }, now)` claims for exactly one account belonging to that worker.
  Disabled workers and accounts, expired sessions and active cooldowns cannot claim. Account-row
  locking enforces `max_concurrency`, including simultaneous requests for the same account.
- The account must support the provider, job type and **every** required provider skill. A required
  version matches exactly; a slug without a version accepts any installed version.
- Eligible jobs sort by interactive, normal, bulk, then least-recent store turn, least-recent requester
  turn within that store, then creation time and ID. Small `generation_store_turns` and
  `generation_requester_turns` tables retain the last dispatch per tier/store and tier/store/requester.
  Claim queries join these unique-keyed cursors, never aggregate historical jobs. Completing,
  requeueing or deleting a job does not reset its turns.
- `generation_dispatch_order_seq` allocates monotonic PostgreSQL bigint dispatch numbers; gaps after
  transaction rollback are harmless. Job and cursor values use native TypeScript `bigint`, including
  values above 2^53. The sequence is non-cycling and bounded by 2^63 - 1 (over 292 billion years at one
  claim per second). Drizzle `pgSequence` generates it in the single 0008 migration; no custom SQL is
  required. The default zero uses SQL because drizzle-kit cannot serialize a JavaScript bigint.
- A partial provider/available-time index scans only queued, uncancelled, unleased candidates. Account
  concurrency uses the account/status index. Fixed queued/uncancelled predicates are SQL literals so
  PostgreSQL can prove partial-index eligibility even for cached generic prepared plans. Claim cost depends on the eligible queue and cursor
  cardinality, not retained completed job history.
- A short advisory transaction lock `(706, 1)` serializes turn allocation across accounts. The candidate
  itself uses `FOR UPDATE SKIP LOCKED`: completion, cancellation or a reaper holding a job row does not
  block a claim on another row. Transactions never include long polling or provider execution.
- Defaults exported for the future HTTP layer: lease 180 seconds, heartbeat 45 seconds, long poll at
  most 25 seconds. A fresh opaque lease token is generated at every claim.

## State changes

`completeJob`, `failJob`, `heartbeatJob` and the reaper use updates guarded by status and lease token.
Workers cannot finish, fail or heartbeat an expired or superseded lease. User cancellation of a queued
job immediately ends it; cancellation of a running job records intent. Completion thereafter returns
`job_not_active`. The worker acknowledges `cancelled`, or the reaper finalizes cancellation when its
lease expires. Cancellation takes precedence even if the job exceeded the account-error loop limit.

`ERROR_CLASSES` mirrors the worker contract's seven error classes. Account errors requeue without
counting an attempt and update account health/cooldown. Input/provider refusals fail immediately.
Transient errors (including expired leases) count once, retry with bounded exponential backoff
(5 seconds initially, at most 300 seconds), and fail when the counted attempt reaches `max_attempts`
(default 3). Rate-limit cooldown defaults to 60 seconds and unavailability to 15 seconds; a validated
worker retry-after overrides these. Account loops fail after more than `maxAccountRequeues` returns
(default 10), with the safe reason `no healthy account available`. A sweep also terminates queued jobs
already beyond that limit. Sweeps default to 100 rows and permit batches of 1–1000.

## User actions and security

`createJob` checks `analysis.run` for analysis and `content.generate` for other kinds. IDs for source
assets/designs must belong to the requested store. `cancelJob` requires the same permission and that
the principal requested the job. Both actions append exactly one secret-free audit row in the same
transaction; denied or losing requests append none. Worker state changes do not add audit noise.

Provider accounts contain metadata, capabilities and health only. Credentials remain on worker
machines. `failJob` requires the contract's `message`: strip Unicode control characters, trim it,
then validate 1–2000 Unicode code points. Store it in `worker_message`, separately from the safe
constant `failure_reason`. Worker text can contain prompt excerpts or other sensitive input: it is
untrusted, operator-only by default, and must never enter audit parameters. `requesterFailureMessage`
returns it only for failed `provider_refused` and `input_invalid` jobs; requesters must never receive a
raw job row. Render this text as plain text only, never HTML or Markdown. HTTP authentication,
idempotency, outputs, usage records, admin notifications, and hard job timeout wiring belong to later
tasks.

## Verification

Integration tests use fresh, locally guarded Postgres databases via `tests/support/db.ts`, never
`pod_dev`. Planned scheduler, transition and reaper tests cover concurrent claims, store/requester
fairness, capability/health gates, races, cancellation, retry caps and lease recovery. No new environment
variables are required.

`pnpm exec vitest run packages/core/test/generation/claim-cost.test.ts` benchmarks actual claim
transactions with the same 2000 queued jobs, 40 stores and 5 requesters before and after adding 50000
completed jobs. It prints warmed median/p95 latency (25 samples each) and the production candidate
query's `EXPLAIN (ANALYZE, BUFFERS)` plan under `force_generic_plan`. The regression gate rejects a sequential history scan and
requires indexed candidate access and cursor joins; timing is reported rather than asserted to avoid CI noise.
