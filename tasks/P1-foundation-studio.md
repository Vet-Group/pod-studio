# P1 Foundation and Studio

Objective: run the complete thin slice from inviting a user -> upload -> job creation -> fake-worker returns images -> approval, without a real worker.

> Every test below: **PLANNED - not implemented, not executed**. Paths are proposed and relative to the monorepo root.

| ID | Task | Owner | Dependencies | Screen |
|---|---|---|---|---|
| P1-01 | Monorepo, tooling and isolated test harness | webapp | none | none |
| P1-02 | Database foundation: Drizzle schema, migrations and conventions | webapp | P1-01 | none |
| P1-03 | Email and password sign-in, admin-created accounts, invites | webapp | P1-02 | 5 |
| P1-04 | Store-scoped permissions, ownership transfer and audit log | webapp | P1-03 | 5 |
| P1-05 | Object storage, assets and per-store design library | webapp | P1-04 | 1 |
| P1-06 | AI job lease table, fair scheduler and reaper | webapp | P1-05 | 1 |
| P1-07 | Worker API v2 routes and worker tokens | webapp + worker team (ngatruong123) | P1-06 | none |
| P1-08 | tools/fake-worker per the contract | webapp | P1-07 | none |
| P1-09 | Studio screen: design library, upload, job creation, queue | webapp | P1-08 | 1 |
| P1-10 | Image review screen | webapp | P1-09 | 2 |
| P1-11 | Realtime status (SSE) and usage_events recording | webapp | P1-07, P1-08, P1-09 | 1 |

---

## P1-01 Monorepo, tooling and isolated test harness

- **Owner:** webapp
- **Dependencies:** none
- **Prototype screen:** none
- **PRD reference:** none (new requirement from ADR/contract)

**Objective.** Set up the pnpm monorepo skeleton and a test suite that runs locally from a clean checkout: each test worker has its own Postgres 16 database and MinIO bucket, with a guard that rejects production URLs.

**Proposed paths**

- `package.json`
- `pnpm-workspace.yaml`
- `tsconfig.base.json`
- `eslint.config.mjs`
- `vitest.workspace.ts`
- `playwright.config.ts`
- `ops/local/docker-compose.yml`
- `tests/support/db.ts`
- `tests/support/storage.ts`
- `tests/support/guard.ts`
- `docs/testing.md`

**Planned tests** (PLANNED - not implemented, not executed)

- `tests/support/guard.test.ts`
  - If DATABASE_URL points to a host other than localhost or the DB name lacks the _test suffix, the test stops immediately
  - Reject an S3 endpoint that is not local MinIO
- `tests/support/db.test.ts`
  - 2 parallel test workers create 2 different databases; writes with the same id do not collide
  - Cleanup only deletes databases created by the test itself

**Done criteria**

- `pnpm test` passes on a new machine with only Docker + Node
- The production guard has a failing test before it passes
- docs/testing.md includes commands to run from a clean checkout

---

## P1-02 Database foundation: Drizzle schema, migrations and conventions

- **Owner:** webapp
- **Dependencies:** P1-01
- **Prototype screen:** none
- **PRD reference:** §4.1-4.4

**Objective.** Set up packages/db with the PRD conventions (text nanoid PKs, no Postgres enums, timestamptz), ordered migrations, and the initial users, sessions, stores, audit_log tables.

**Proposed paths**

- `packages/db/src/schema/index.ts`
- `packages/db/src/schema/users.ts`
- `packages/db/src/schema/stores.ts`
- `packages/db/src/schema/audit.ts`
- `packages/db/src/ids.ts`
- `packages/db/migrations/`
- `packages/db/drizzle.config.ts`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/db/test/migrations.test.ts`
  - All migrations run successfully on an empty DB; running them again for a 2nd time changes nothing
  - No Postgres enum types exist in the schema after migration (query pg_type)
- `packages/db/test/ids.test.ts`
  - newId() generates strings matching the contract pattern ^[A-Za-z0-9_-]{8,40}$

**Done criteria**

- Migrations run on an empty DB and are idempotent
- The schema follows the conventions, with tests to verify them

---

## P1-03 Email and password sign-in, admin-created accounts, invites

- **Owner:** webapp
- **Dependencies:** P1-02
- **Prototype screen:** 5
- **PRD reference:** §10

**Objective.** Use better-auth with email + password, store sessions in Postgres, and disable public sign-up. Admins create accounts with a temporary password (a change is required on first sign-in) or create invite links; invitees enter their own name and password. No SMTP is required.

**Proposed paths**

- `packages/core/src/auth/auth.ts`
- `packages/core/src/auth/invites.ts`
- `packages/db/src/schema/invites.ts`
- `apps/web/src/app/(auth)/login/page.tsx`
- `apps/web/src/app/(auth)/invite/[token]/page.tsx`
- `apps/web/src/app/(auth)/change-password/page.tsx`
- `apps/web/src/app/api/auth/[...all]/route.ts`
- `apps/web/src/middleware.ts`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/core/test/auth/invites.test.ts`
  - Tokens are stored only as hashes, with no plaintext in the DB
  - Reuse of an already accepted token: rejected (replay)
  - A token expired after 7 days: rejected
  - A revoked token: rejected
  - Inviters cannot grant permissions they do not have (privilege escalation through invites)
  - Store invites can only be created by someone with store.members for that specific store
- `packages/core/test/auth/signup.test.ts`
  - Calling the better-auth sign-up endpoint directly: returns an error and does not create a user
  - Accounts with temporary passwords are blocked from every page except password change
- `tests/e2e/auth.spec.ts`
  - An admin creates an invite and copies the link; a new user opens the link, sets a password, and can access the app
  - Signing out revokes the session in the DB

**Done criteria**

- All bypass, replay, expiry, revocation, and privilege escalation scenarios have failing tests before they pass
- There is no user creation path other than admin creation and invites

---

## P1-04 Store-scoped permissions, ownership transfer and audit log

- **Owner:** webapp
- **Dependencies:** P1-03
- **Prototype screen:** 5
- **PRD reference:** none (new requirement from ADR/contract)

**Objective.** Create the store_members table with preset roles and permissions[]; the can(principal, permission, {storeId}) function in packages/core is the sole permission-checking point; audit_log records actor_user_id, actor_kind for every permission change and sensitive action. Stores & members screen (screen 5).

**Proposed paths**

- `packages/core/src/access/permissions.ts`
- `packages/core/src/access/can.ts`
- `packages/core/src/access/members.ts`
- `packages/core/src/audit/log.ts`
- `packages/db/src/schema/store-members.ts`
- `apps/web/src/app/(app)/stores/page.tsx`
- `apps/web/src/app/(app)/stores/[storeId]/members/page.tsx`
- `apps/web/src/features/stores/member-table.tsx`
- `apps/web/src/features/stores/invite-dialog.tsx`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/core/test/access/can.test.ts`
  - The preset x permission matrix matches ADR 0002 (table-driven tests)
  - System admins do not have product.push or product.publish in stores where those permissions have not been granted
  - seller_support does not have product.publish by default
  - Permissions for store A cannot be used in store B
- `packages/core/test/access/members.test.ts`
  - Only the owner can grant product.publish
  - No one can grant permissions they do not have
  - The last owner cannot be removed or demoted
  - Each store has exactly 1 owner (DB constraint, 2 racing transactions)
  - Only the owner or an admin can transfer ownership, with an audit_log record
- `tests/e2e/stores-members.spec.ts`
  - The owner enables publish for co_leader, and co_leader sees the Public button; disabling it makes the button disappear
  - Permission status is displayed with text and icons, not just color

**Done criteria**

- Every server action involving a store goes through can()
- The permission matrix has table-driven tests
- Every permission change has an audit_log row

---

## P1-05 Object storage, assets and per-store design library

- **Owner:** webapp
- **Dependencies:** P1-04
- **Prototype screen:** 1
- **PRD reference:** §13

**Objective.** Upload directly to S3 using presigned PUT, verify sha256, deduplicate by (store_id, sha256), and read images through short-lived presigned GET. Designs are store-scoped by default until a shared-use policy is finalized.

**Proposed paths**

- `packages/core/src/assets/storage.ts`
- `packages/core/src/assets/assets.ts`
- `packages/core/src/designs/designs.ts`
- `packages/db/src/schema/assets.ts`
- `packages/db/src/schema/designs.ts`
- `apps/web/src/features/designs/upload-queue.ts`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/core/test/assets/assets.test.ts`
  - Upload a file with an incorrect declared sha256: finalization is rejected and the object is deleted
  - Upload the same file 2 times in 1 store: 1 asset
  - A member of store B cannot obtain a presigned URL for an image in store A
  - Presigned URLs expire at the configured time
- `packages/core/test/designs/scope.test.ts`
  - By default, a design is only visible in the store where it was uploaded
  - Sharing a design with another store requires permission and an audit_log record

**Done criteria**

- No file read path bypasses store permission checks
- Deduplication and checksums have tests

---

## P1-06 AI job lease table, fair scheduler and reaper

- **Owner:** webapp
- **Dependencies:** P1-05
- **Prototype screen:** 1
- **PRD reference:** §5.1, §8.5

**Objective.** Create the generation_jobs table with lease_token, lease_expires_at, attempt, error_class, priority; claim using FOR UPDATE SKIP LOCKED in order of tier, round-robin across stores, round-robin across requesters, and job age; the reaper returns jobs with expired leases to the queue; create the provider_accounts and workers tables.

**Proposed paths**

- `packages/db/src/schema/generation-jobs.ts`
- `packages/db/src/schema/provider-accounts.ts`
- `packages/db/src/schema/workers.ts`
- `packages/core/src/generation/scheduler.ts`
- `packages/core/src/generation/transitions.ts`
- `packages/core/src/generation/error-classes.ts`
- `apps/jobs/src/reapers/lease-reaper.ts`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/core/test/generation/claim.test.ts`
  - 50 parallel claims on 20 jobs: no job is claimed 2 times
  - Store A has 200 jobs and store B has 2 jobs: B's jobs are claimed within the first 2 turns
  - An account missing a required provider skill does not receive jobs that require that skill
  - An account in cooldown or with an expired session cannot claim jobs
- `packages/core/test/generation/transitions.test.ts`
  - Error class table: each class produces the correct job and account states and determines whether an attempt is counted
  - Transitions use UPDATE guarded by status + lease_token; 2 racing updates yield only 1 winner
  - Cancellation wins over completion: if cancel is recorded first, complete returns job_not_active
- `apps/jobs/test/lease-reaper.test.ts`
  - A job with an expired lease and no complete/fail: returns to queued, counting 1 transient attempt
  - Exceeding maxAttempts: failed; returned to the queue more than N times due to account errors: failed with the reason that no healthy account is available

**Done criteria**

- Tests verify no double claims under parallel load
- Store-level fairness has tests
- Every transition is a guarded UPDATE

---

## P1-07 Worker API v2 routes and worker tokens

- **Owner:** webapp + worker team (ngatruong123)
- **Dependencies:** P1-06
- **Prototype screen:** none
- **PRD reference:** §8.5

**Objective.** Implement packages/contracts exactly (OpenAPI 3.1, X-Contract-Version: 2) under /api/worker/v2: register, claim long-poll, heartbeat, uploads, complete, fail, account status, skill version. Each worker has its own token, stored as a hash. The worker team (ngatruong123) approves the contract before work begins.

**Proposed paths**

- `apps/web/src/app/api/worker/v2/register/route.ts`
- `apps/web/src/app/api/worker/v2/claim/route.ts`
- `apps/web/src/app/api/worker/v2/jobs/[jobId]/heartbeat/route.ts`
- `apps/web/src/app/api/worker/v2/jobs/[jobId]/uploads/route.ts`
- `apps/web/src/app/api/worker/v2/jobs/[jobId]/complete/route.ts`
- `apps/web/src/app/api/worker/v2/jobs/[jobId]/fail/route.ts`
- `apps/web/src/app/api/worker/v2/accounts/[accountId]/status/route.ts`
- `apps/web/src/app/api/worker/v2/skills/[versionId]/route.ts`
- `packages/core/src/workers/tokens.ts`
- `packages/core/src/workers/idempotency.ts`
- `packages/contracts/`

**Planned tests** (PLANNED - not implemented, not executed)

- `tests/contract/worker-api.test.ts`
  - Every response matches the OpenAPI schema (validate with Ajv from packages/contracts)
  - A stale lease: 409 lease_lost
  - Repeated complete with the same Idempotency-Key: returns the first result without creating duplicate results
  - The same key with a different body: 422 idempotency_key_reused
  - Missing uploadKey or mismatched sha256: 422
  - Missing or incorrect X-Contract-Version: 426
  - A revoked token: 401
- `tests/contract/cancel-race.test.ts`
  - Cancel and complete are sent concurrently 100 times: the job always ends in exactly 1 state, and uploaded files from the losing branch are cleaned up

**Done criteria**

- Contract tests pass for all examples in packages/contracts/examples
- The worker team (ngatruong123) confirms the contract in writing (comment/issue)

---

## P1-08 tools/fake-worker per the contract

- **Owner:** webapp
- **Dependencies:** P1-07
- **Prototype screen:** none
- **PRD reference:** none (new requirement from ADR/contract)

**Objective.** A fake Node worker communicates only through Worker API v2 and presigned URLs, with scenarios for success, slow execution with heartbeat, rate limits, session expiry, a mid-run crash, and returning images with incorrect checksums. Used for development, E2E, and load measurement.

**Proposed paths**

- `tools/fake-worker/src/index.ts`
- `tools/fake-worker/src/scenarios.ts`
- `tools/fake-worker/assets/`
- `tools/fake-worker/README.md`

**Planned tests** (PLANNED - not implemented, not executed)

- `tools/fake-worker/test/scenarios.test.ts`
  - success scenario: the job reaches succeeded with all images present
  - rate_limited scenario: the account enters cooldown, the job returns to queued, and attempt does not increase
  - crash scenario: the reaper returns the job to the queue after the lease expires
  - The worker rejects URLs outside storageOrigins

**Done criteria**

- Runs with 1 command, with the scenario configured through parameters
- Does not import internal apps/web code (uses only contracts)

---

## P1-09 Studio screen: design library, upload, job creation, queue

- **Owner:** webapp
- **Dependencies:** P1-08
- **Prototype screen:** 1
- **PRD reference:** §11.3

**Objective.** Screen 1 from the prototype: a virtualized design grid, filtering and search through the URL (nuqs), bulk upload including entire folders, a mockup/redesign creation drawer with skill and quantity selection, and a queue drawer with position, status, cancellation, and rerun.

**Proposed paths**

- `apps/web/src/app/(app)/studio/page.tsx`
- `apps/web/src/features/studio/design-grid.tsx`
- `apps/web/src/features/studio/upload-drawer.tsx`
- `apps/web/src/features/studio/create-job-drawer.tsx`
- `apps/web/src/features/studio/queue-drawer.tsx`
- `apps/web/src/features/studio/actions.ts`

**Planned tests** (PLANNED - not implemented, not executed)

- `tests/e2e/studio.spec.ts`
  - Upload 20 files with 1 duplicate: 19 new designs, with a clear duplicate notification
  - Create a mockup job for 10 images: the job appears in the queue with its position
  - Cancel a running job: its status changes to Cancelled
  - Filters and search persist after reload (URL state)
- `tests/e2e/studio-a11y.spec.ts`
  - axe reports no serious violations
  - The drawer traps focus; Esc closes it and returns focus to the opening button

**Done criteria**

- The upload -> create job -> see it in the queue flow works with fake-worker
- A grid of 1,000 designs scrolls smoothly (virtual list)

---

## P1-10 Image review screen

- **Owner:** webapp
- **Dependencies:** P1-09
- **Prototype screen:** 2
- **PRD reference:** §5.1, §11.3

**Objective.** Screen 2: the original design is placed beside the results, with keyboard shortcuts A to approve, R to reject (reason required), arrow keys to switch images, and bulk approval; rejection reasons are stored to measure skill quality.

**Proposed paths**

- `apps/web/src/app/(app)/review/page.tsx`
- `apps/web/src/features/review/review-stage.tsx`
- `apps/web/src/features/review/use-review-keys.ts`
- `apps/web/src/features/review/reject-dialog.tsx`
- `packages/core/src/generation/review.ts`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/core/test/generation/review.test.ts`
  - A user without permission in the design's store cannot approve it
  - Rejection without a reason: rejected
- `tests/e2e/review.spec.ts`
  - A approves, R opens the reason dialog, and arrow keys switch images
  - Keyboard shortcuts do not activate while typing in an input
  - Review status is displayed with text + icons, not just color
  - No horizontal overflow at 390px

**Done criteria**

- 50 images can be approved using only the keyboard
- Rejection reasons are stored with the job's skill_version_id

---

## P1-11 Realtime status (SSE) and usage_events recording

- **Owner:** webapp
- **Dependencies:** P1-07, P1-08, P1-09
- **Prototype screen:** 1
- **PRD reference:** §14

**Objective.** SSE is scoped per store, sourced from Postgres LISTEN/NOTIFY after commit; every finished job records usage_events (job_id, job_type, provider, account_id, requester_id, store_id, store_owner_id_at_time, units). There are no limits or quotas.

**Proposed paths**

- `apps/web/src/app/api/events/route.ts`
- `packages/core/src/events/notify.ts`
- `packages/core/src/usage/record.ts`
- `packages/db/src/schema/usage-events.ts`
- `apps/web/src/features/realtime/use-store-events.ts`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/core/test/usage/record.test.ts`
  - A succeeded job records exactly 1 usage_event; repeated complete does not record additional events
  - If the owner changes later, earlier usage still retains the original store_owner_id_at_time
- `tests/integration/sse.test.ts`
  - A client for store A does not receive events from store B
  - Events are emitted only after commit; rollback emits none

**Done criteria**

- The queue updates without polling
- Read-only queries aggregate usage by store and by owner
