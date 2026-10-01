# P1-P3 implementation plan

This is a plan for a new build, not a report of completed implementation. The PRD is a reference document, not a codebase to port or data to migrate.

## How to read this plan

- `tasks.json` is the structured catalog; the P1, P2, P3 files present the same content in full for readers.
- IDs are stable, in the form `P1-01`. `depends_on` lists technical prerequisites that must be completed before task acceptance; design work can proceed in parallel.
- `owner`: `web` is the web team, `worker` is the worker team (ngatruong123), and `both` means collaboration between the two teams. The actual worker code lives in an external repo; neither its path nor the existence of that repo is assumed.
- Implementation paths are PROPOSED and relative to the monorepo root; they do not assert that files already exist. This repo contains only the web server, internal jobs, contracts, and fake-worker, not the actual AI runtime.
- `screens` uses prototype numbers 1-7; an empty list means none. `prd_refs` uses only verified sections; an empty list means a new ADR or contract requirement.
- Every test in the plan is labeled `PLANNED - not implemented, not executed`. Done criteria are future acceptance conditions, not test results.

## Goals and acceptance criteria by phase

| Phase | Goal | Acceptance criteria |
| --- | --- | --- |
| P1 | Foundation, accounts, permissions, assets, generation, and Studio/Review | An invitee signs in, selects a valid store, uploads, generates mockups, tracks and approves results through fake-worker. Prove isolation, leases, cancellation, and permissions with actual tests before declaring completion. |
| P2 | Listing, catalog, and Shopify | Create products with correct pricing from approved results; dry-run is mandatory; pushing defaults to draft; publishing checks its separate permission at execution time. Timeouts after writes are reconciled, not blindly retried. |
| P3 | Skills, operations, security, and UI quality | Skill versions are immutable, routing follows installations, tokens can be revoked, and operations are backed by evidence; benchmarks report measured load, and the UI passes keyboard/axe checks at three viewports. |

## Dependencies and critical path

- Foundation: P1-01 -> P1-02 -> P1-03 -> P1-04 -> P1-05 -> P1-06 -> P1-07.
- Studio: P1-07 -> P1-08 -> P1-09 -> P1-10; P1-11 adds SSE and usage and depends on P1-07/P1-08/P1-09.
- Commerce: P1-10 + P2-01 + P2-03 -> P2-04 -> P2-06 -> P2-07 -> P2-08; P2-05 provides the Shopify client, P2-09 request-push, and P2-10 import/resync.
- Operations: P3-01 -> P3-02 -> P3-03 -> P3-04. P3-05 hardens security, P3-06 adds telemetry, P3-07 measures load, and P3-08 finalizes the UI.
- Niche and secrets: P3-01 + P3-02 -> P3-09 -> P3-10 (author master data, score, build). P3-04 + P3-05 -> P3-11 (OpenBao, automatic re-login).
- The `depends_on` lists in JSON are the authoritative source for the graph. Design for each phase can begin early, but acceptance requires the corresponding prerequisites to have passed.

## Prototype mapping

| Screen | Content | Main tasks |
| --- | --- | --- |
| 1 | Studio: Design library, upload, create mockup, queue | P1-05, P1-09, P1-11 |
| 2 | Review: Design review, original/mockups, A/R/arrows, rejection reason | P1-10 |
| 3 | Listing: Listing content and analysis | P2-01, P2-02 |
| 4 | Products: Products & push, variants, dry-run, push/publish | P2-03, P2-04, P2-06, P2-07, P2-08, P2-09, P2-10 |
| 5 | Team: Stores & members, push/publish toggles, invite | P1-03, P1-04, P2-05 |
| 6 | Skills: Skills & operations, accounts and worker health | P3-01, P3-02, P3-03, P3-04, P3-06, P3-07, P3-11 |
| 7 | Niche: Niche data, master data editor, market fit, build skill version | P3-09, P3-10 |

P3-05 protects every screen; P3-08 checks all seven screens.

## Testing strategy

**PLANNED - not implemented, not executed**

- Unit: Vitest for policy, pricing, state machines, templates, and payloads; injectable clock/RNG to test expiry and fairness.
- Integration: Real Postgres 16, with a separate schema or database for each test/worker; actual migrations and competing transactions. A guard rejects production URLs; no shared truncate; cleanup only removes namespaces created by the test. Separate MinIO for asset/upload tests.
- Contract: OpenAPI 3.1 Worker API v2 at `packages/contracts/openapi/worker-api.yaml`, version `2.0.0-draft.1`, header `X-Contract-Version: 2`, prefix `/api/worker/v2`. Fake-worker verifies requests/responses, HTTP codes, leases, and presigned storage; the external runtime communicates only through the contract and object storage.
- E2E: Playwright runs the auth -> Studio -> Review -> Listing -> draft/publish flow, using fake-worker and a Shopify stub with deterministic side effects. Smoke tests against a real Shopify sandbox are a separate gate requiring supplied credentials; the default suite makes no live calls.
- A11y: axe + manual keyboard checks with a checklist; passing axe alone is not enough.
- Load: Real Postgres/MinIO, with the workload documented in P3-07; report p95, errors, fairness, queue drain, and machine configuration. Capacity is measured, not a promise of unlimited scale.
- Local execution does not depend on CI. The test harness README will provide commands for a clean checkout; report a pass only after actual execution. Do not use fabricated data to report benchmark results.

## Architecture constraints

- Next.js App Router, React, TypeScript strict, Tailwind v4, shadcn/ui; TanStack Query/Table/Virtual, nuqs, zustand, react-hook-form + zod; no Preact Signals. Versions in the ADR are a planned snapshot.
- better-auth email/password, sessions in Postgres, no SSO and no public signup. pg-boss is only for internal push/reaper/notification jobs; AI jobs use a separate lease table over HTTP. SSE uses LISTEN/NOTIFY.
- Admins do not automatically have push/publish permissions. `product.push` and `product.publish` are separate; only the owner can grant publish; no one can grant permissions they do not have. Job execution must recheck stored permissions rather than trust the UI.
- No quotas, budgets, or paid API fallback. Only record usage_events; owner attribution is a snapshot at the time of the event.
- The old worker API content in the PRD is not the standard. Do not promise to port storekit/mockup-worker or migrate data from a repo that does not yet exist.

## Open decisions

| Topic | Implementation default | Decision needed |
| --- | --- | --- |
| Who can create stores | Fail closed with a separate permission; self-service creation is not enabled for members | The project owner must choose admin-only or a permitted group, and the process for granting ownership |
| Production host/object storage | Local Postgres 16 + MinIO for dev/test | Host, region, TLS, backups, key management, bucket lifecycle, and production storageOrigins |
| Real email | Copyable invite links; SMTP is not required | Mail provider, sender domain, delivery, and password reset process before production |

## Documentation verification gate

Files in this directory: `tasks.json` (authoritative source), `P1-foundation-studio.md`, `P2-listing-shopify.md`, `P3-skills-operations.md`, `validate-tasks.mjs`.

```bash
node tasks/validate-tasks.mjs
```

The script checks: 30-40 tasks, unique IDs, existing dependencies that do not point to a later phase, no cycles, paths, tests (labeled PLANNED), and done criteria for each task, coverage of all 7 prototype screens, markdown files containing all sections for their phase, and no em dashes, en dashes, smart quotes, or ellipses. This check verifies only the plan; it does not run product tests.
