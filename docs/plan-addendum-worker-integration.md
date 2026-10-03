# Worker integration and storage plan addendum

**Status:** proposed sequencing adjustment before completing P1-09
**Date:** 2026-10-03
**Web snapshot:** `024f2f74bea48a2df40accf5085c62bb47b9bddc`
**Worker snapshot reviewed:** `d4c7826c1d7da8f37587448f5b3a44eb3f336250`

This addendum preserves the existing P1-P3 plan. It does not replace the plan, change ownership, or make the external worker repository a dependency in the web repository. The worker/web boundary remains Worker API v2 plus presigned object URLs.

## Decision

Do not start the P1-09 job-creation and queue acceptance tests against the current web model without a contract-ready adapter. Read-only design-library and upload work may proceed, but job creation, worker dispatch, cancellation and queue completion must pass the gates below first.

Do not switch local or production object storage to MinIO AIStor Free now. Keep the pinned Chainguard MinIO stack. Evaluate AIStor later in an isolated storage spike; never replace the current image or reuse its data volume without backup, migration and rollback evidence.

## Revised delivery order

### Gate A — P1-08 worker/client hardening (web-owned fake-worker)

Keep the existing P1-08 verification result (the contract scenarios and full suite pass), and add a follow-up hardening gate before using fake-worker as a stronger integration oracle:

- Pass an `AbortSignal` through heartbeat requests and retry delays. Cancellation must stop a pending heartbeat/retry and must not send `complete` after cancellation.
- Measure peak RSS for image count and `minLongEdge` cases, including a bounded 8192-square probe. Choose and test a memory/staging bound, or upload outputs one at a time/bounded, rather than relying on an unmeasured assumption.
- Validate `WorkerClient` library `baseUrl`, not only CLI input: reject embedded credentials, query strings, fragments and unsafe paths; preserve storage-origin and credential-isolation checks.

These are quality gates, not a Worker API contract revision. The 4 GB retained-memory claim is not accepted without a measurement; current evidence only establishes a potentially large raw image allocation and compressed output staging.

### Gate B — P1-09A contract-ready generation adapter (new subtask under P1-09)

Before the Studio job drawer is accepted, implement and test a web-owned adapter that turns a user request into a claimable `generation_jobs` row and a valid wire job:

- Normalize one canonical internal-to-wire job type at the scheduler selection boundary, before candidate filtering. Do not rely on response-only aliases such as `generate` to `mockup`.
- Populate and validate immutable job inputs: rendered `prompt`, optional `systemPrompt`, typed `params`, `inputs[]` with asset roles and store ownership, selected `skill`/version, `requiredProviderSkills`, model, count, ratio, intent/mode and minimum output size.
- Limit P1-09's enabled lanes to `mockup` and `redesign` until a worker capability is proven for `listing_content` and `product_analysis`; schema acceptance alone is not execution support.
- Make claim response construction/asset signing failure-safe. A post-claim failure must not strand a job with an unseen active lease; add a recovery or transaction boundary and regression tests.
- Add capability-aware UI/API behavior from registered `jobTypes` and installed skill inventory. Do not show a skill/provider combination the selected account cannot claim.

Acceptance: create → claim → complete through the real Worker API returns a schema-valid `ClaimedJob`, the exact input assets are scoped to the store, unsupported lanes are rejected explicitly, and no malformed/unavailable-input job remains running invisibly.

### Gate C — P1-09 Studio screen

After Gate B, continue the existing design grid, bulk upload, create-job drawer, queue drawer, URL filters/search, cancel and rerun. The drawer must create the typed redesign/mockup params above; rerun creates a new job and never mutates the historical job. Cancellation must obey cancel-wins-over-complete and clean losing uploads.

The read-only design library/upload surface can be implemented in parallel, but P1-09 is not done until the Gate B acceptance and end-to-end tests pass.

### Gate D — P1-11 lifecycle and realtime

Extend P1-11 acceptance beyond SSE and usage aggregation:

- wire the lease reaper into a bounded recurring runtime with outcome/ retry observability;
- emit store-scoped events only after commit for queued/running/completed/failed/cancelled/requeued transitions;
- ensure cancel cannot produce a later fake complete event;
- keep complete idempotent and record exactly one usage event per successful job, retaining the owner-at-time value.

A unit-tested reaper helper without a production invocation is not completion evidence.

### Gate E — P3-03 routing split

Treat provider-install routing as the prerequisite portion of P3-03: registration/account status must maintain installed skill inventory, and the scheduler must refuse a job when the required slug/version is unavailable. Keep A/B trials and approval-rate analytics as the later, non-blocking analytics portion.

## External worker coordination

The reviewed worker revision is a persistent image runner for `mockup`/`redesign`; `listing_content` and `product_analysis` are not proven Studio execution lanes. Its heartbeat currently needs coverage through output preparation/upload/complete, not only provider generation. These are coordination gates for the worker owner and must not be silently implemented by changing the web repository's ownership boundary.

The worker and web contract bundles were semantically equal in the audit (59 definitions, no differences). Keep contract CI pinned to the canonical `packages/contracts` path and compare the worker's generated/vendored bundle before accepting future worker updates.

## AIStor Free decision and optional spike

The external license file remains outside Git and must not be copied into the repository or logs. Local metadata inspection was not a cryptographic activation check. Official AIStor documentation and the Free Agreement indicate single-node standalone use, including commercial workloads, but not HA/distributed deployment; the detailed license documentation also excludes paid-tier features such as replication, tiering/lifecycle transitions, version-specific deletion and encryption at rest.

Create a separate, non-blocking storage spike only after the current flow is stable:

1. pin an exact AIStor server and utility-client image;
2. mount the license read-only from an operator-managed path and verify status locally;
3. use a fresh isolated volume/profile;
4. test bucket bootstrap, least-privilege user, private access, presigned PUT/GET/DELETE, content type, byte count, checksum, proxy signing and healthcheck/restart;
5. run asset and fake-worker integration suites plus backup/restore SHA-256 verification;
6. decide separately whether single-node downtime and lack of at-rest encryption fit the production threat/recovery model.

Until that spike passes, the existing Chainguard MinIO configuration remains the only supported path. `minio` and `minio-init` currently share the pinned image, so an AIStor experiment cannot be a blind image substitution.

## Evidence sources

- `packages/core/src/generation/transitions.ts`
- `packages/core/src/generation/scheduler.ts`
- `packages/core/src/workers/api.ts`
- `packages/db/src/schema/generation-jobs.ts`
- `apps/jobs/src/reapers/lease-reaper.ts`
- `tasks/P1-foundation-studio.md`
- `tasks/P3-skills-operations.md`
- `docs/assets.md`
- `ops/local/docker-compose.yml`
- `ops/prod/docker-compose.yml`
- `C:/Users/Administrator/AppData/Local/hermes/cache/scratch/p1-08-worker-audit.md`
- MinIO AIStor documentation: `https://docs.min.io/aistor/operations/licenses/`
- MinIO AIStor Free Agreement: `https://www.min.io/legal/aistor-free-agreement`
