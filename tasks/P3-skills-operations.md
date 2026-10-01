# P3 Skills and operations

Goal: an immutable skill lifecycle, account/worker operations, security hardening, load testing with measurements, and UI polish.

> All tests below: **PLANNED - not implemented, not executed**. Paths are proposed and relative to the monorepo root.

| ID | Task | Owner | Dependencies | Screen |
|---|---|---|---|---|
| P3-01 | Skill lifecycle: draft, review, publish, deprecate | webapp + worker team (ngatruong123) | P1-07 | 6 |
| P3-02 | Niche agent packages: safe zip upload and validator | webapp + worker team (ngatruong123) | P3-01 | 6 |
| P3-03 | Provider skills: install tracking and routing | webapp + worker team (ngatruong123) | P3-02 | 6 |
| P3-04 | AI account and worker screen (admin) | webapp | P3-03 | 6 |
| P3-05 | Security hardening | webapp | P1-03, P1-07, P2-05 | none |
| P3-06 | Usage observability and reporting | webapp | P1-11, P3-04 | 6 |
| P3-07 | Load testing per profile and pass gates | webapp | P1-06, P1-07, P1-08, P3-06 | 6 |
| P3-08 | UI polish and accessibility | webapp | P1-09, P1-10, P2-02, P2-08, P3-04 | 1, 2, 3, 4, 5, 6, 7 |
| P3-09 | Niche master data editor (schema 2.0) | webapp | P3-01, P3-02 | 7 |
| P3-10 | Market-fit scoring and skill version builds from master data | webapp + worker team (ngatruong123) | P3-09 | 7 |
| P3-11 | OpenBao secret store for subscription accounts and automatic re-login | webapp + worker team (ngatruong123) | P3-04, P3-05 | 6 |

---

## P3-01 Skill lifecycle: draft, review, publish, deprecate

- **Owner:** webapp + worker team (ngatruong123)
- **Dependencies:** P1-07
- **Prototype screen:** 6
- **PRD reference:** none (new requirement from the ADR/contract)

**Goal.** Skills and skill_versions are immutable according to the manifest in packages/contracts; check that template variables match their declarations; diff 2 versions; users with skill.publish approve; jobs record skill_version_id; assign default skills by job type, product type, and niche.

**Proposed paths**

- `packages/core/src/skills/registry.ts`
- `packages/core/src/skills/render.ts`
- `packages/core/src/skills/bindings.ts`
- `packages/db/src/schema/skills.ts`
- `apps/web/src/app/(app)/skills/page.tsx`
- `apps/web/src/features/skills/template-editor.tsx`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/core/test/skills/registry.test.ts`
  - Editing a published version: rejected; a new version must be created
  - A template uses an undeclared variable: rejected on save
  - A manifest violates the schema: rejected with the error path
- `packages/core/test/skills/render.test.ts`
  - The prompt renders the correct variables; user input cannot inject unknown variables

**Completion criteria**

- Every AI job can be traced to the correct skill version

---

## P3-02 Niche agent packages: safe zip upload and validator

- **Owner:** webapp + worker team (ngatruong123)
- **Dependencies:** P3-01
- **Prototype screen:** 6
- **PRD reference:** none (new requirement from the ADR/contract)

**Goal.** Upload niche skill zip archives; extract with path checks, size limits, and file count limits; run the pod-skill-builder Python validator as a subprocess with a timeout, and map errors to fields.

**Proposed paths**

- `packages/core/src/skills/archive.ts`
- `packages/core/src/skills/validator.ts`
- `apps/jobs/src/skills/validate-job.ts`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/core/test/skills/archive.test.ts`
  - A zip contains ../ or absolute paths: rejected (zip-slip)
  - A zip bomb exceeds the extraction limit: stopped
  - The maximum file count is exceeded: rejected
  - A symlink in the zip: rejected
- `packages/core/test/skills/validator.test.ts`
  - The validator exceeds the timeout: killed, with a clear error returned
  - Validator output maps to the correct fields

**Completion criteria**

- No file is written outside the temporary directory for that extraction

---

## P3-03 Provider skills: install tracking and routing

- **Owner:** webapp + worker team (ngatruong123)
- **Dependencies:** P3-02
- **Prototype screen:** 6
- **PRD reference:** none (new requirement from the ADR/contract)

**Goal.** Track which provider skill versions are installed on each account (from register and account status); the scheduler assigns jobs requiring a skill only to accounts with that skill installed; run A/B trials and measure image approval rates by skill version.

**Proposed paths**

- `packages/core/src/skills/provider-install.ts`
- `packages/core/src/skills/test-runs.ts`
- `packages/db/src/schema/skill-installs.ts`
- `apps/web/src/features/skills/approval-rate.tsx`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/core/test/skills/provider-install.test.ts`
  - An account reports uninstalling a skill: jobs requiring that skill are no longer assigned to that account
  - Approval rates are calculated correctly by skill version x provider

**Completion criteria**

- It is clear which skills yield better approval rates

---

## P3-04 AI account and worker screen (admin)

- **Owner:** webapp
- **Dependencies:** P3-03
- **Prototype screen:** 6
- **PRD reference:** none (new requirement from the ADR/contract)

**Goal.** The operations section of screen 6: account status (running, paused, session expired, waiting for worker), online workers and their last heartbeat, running jobs, and installed skills; a "Logged in again" button; issue and revoke worker tokens (shown 1 time, stored as hashes).

**Proposed paths**

- `apps/web/src/app/(app)/admin/accounts/page.tsx`
- `apps/web/src/app/(app)/admin/workers/page.tsx`
- `apps/web/src/features/admin/account-table.tsx`
- `apps/web/src/features/admin/worker-token-dialog.tsx`
- `packages/core/src/workers/admin.ts`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/core/test/workers/admin.test.ts`
  - A worker token is shown only 1 time; the DB contains only its hash
  - A token is revoked: the next request returns 401
  - Only admins can access it
- `tests/e2e/admin-accounts.spec.ts`
  - An account with an expired session is clearly marked with text + an icon; clicking "Logged in again" waits for worker confirmation

**Completion criteria**

- Admins immediately know which accounts need to log in again

---

## P3-05 Security hardening

- **Owner:** webapp
- **Dependencies:** P1-03, P1-07, P2-05
- **Prototype screen:** none
- **PRD reference:** §6.1

**Goal.** Rate limits for sign-in, invite creation, and the worker API; CSP and security headers; CSRF for server actions; storageOrigins to prevent SSRF; log redaction; dependency audits; a security review checklist before production.

**Proposed paths**

- `apps/web/src/middleware.ts`
- `apps/web/next.config.ts`
- `packages/core/src/security/rate-limit.ts`
- `packages/core/src/logging/redact.ts`
- `docs/security-checklist.md`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/core/test/security/rate-limit.test.ts`
  - Incorrect passwords exceed the threshold: temporary lockout by account and IP
- `packages/core/test/logging/redact.test.ts`
  - Logs contain tokens, cookies, or secrets: redacted before writing
- `tests/e2e/security-headers.spec.ts`
  - Every page has CSP, X-Frame-Options, and Referrer-Policy configured correctly

**Completion criteria**

- The security checklist passes and has been reviewed

---

## P3-06 Usage observability and reporting

- **Owner:** webapp
- **Dependencies:** P1-11, P3-04
- **Prototype screen:** 6
- **PRD reference:** §14

**Goal.** Structured logs and metrics (queue depth, claim time, expired leases, account status); alerts when an account session expires or the queue is stuck; audit log viewing; usage reports by store and owner (read-only, no limits).

**Proposed paths**

- `packages/core/src/observability/metrics.ts`
- `apps/jobs/src/alerts/account-alerts.ts`
- `apps/web/src/app/(app)/admin/audit/page.tsx`
- `apps/web/src/app/(app)/admin/usage/page.tsx`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/core/test/observability/metrics.test.ts`
  - The queue metric matches the actual number of queued jobs in the DB
- `apps/jobs/test/account-alerts.test.ts`
  - An account transitions to session_expired: exactly 1 alert, no spam

**Completion criteria**

- An operations dashboard provides enough information for on-call monitoring without reading the DB

---

## P3-07 Load testing per profile and pass gates

- **Owner:** webapp
- **Dependencies:** P1-06, P1-07, P1-08, P3-06
- **Prototype screen:** 6
- **PRD reference:** none (new requirement from the ADR/contract)

**Goal.** Measure against real Postgres and MinIO using fake-worker. Proposed profiles: A = 50 UI users + 20 accounts + 5,000 jobs; B = 200 users + 100 accounts + 50,000 jobs. Proposed pass gates (finalize when production hardware is available): claim p95 < 200 ms, no double claims, no store waits more than 3 rotation cycles. Publish the hardware configuration; capacity is a measurement, not a promise of unlimited capacity.

**Proposed paths**

- `tests/load/profiles.ts`
- `tests/load/run.ts`
- `tests/load/report.md`

**Planned tests** (PLANNED - not implemented, not executed)

- `tests/load/run.ts`
  - Profiles A and B run for the full duration and report p50/p95/p99, errors, fairness, and queue drain time

**Completion criteria**

- A report includes real measurements and the hardware configuration
- Clearly state the thresholds that require more workers or a separate DB

---

## P3-08 UI polish and accessibility

- **Owner:** webapp
- **Dependencies:** P1-09, P1-10, P2-02, P2-08, P3-04
- **Prototype screen:** 1, 2, 3, 4, 5, 6
- **PRD reference:** §11.2

**Goal.** Review all 6 screens at 1440, 1024, and 390: no horizontal overflow, full keyboard operation, states not conveyed by color alone, reduced motion, clean axe results, and screenshot comparisons to detect broken layouts.

**Proposed paths**

- `packages/ui/src/tokens.css`
- `packages/ui/src/components/`
- `tests/e2e/visual/`

**Planned tests** (PLANNED - not implemented, not executed)

- `tests/e2e/visual/screens.spec.ts`
  - 6 screens x 3 sizes: no horizontal overflow; screenshots match the baseline within the threshold
- `tests/e2e/a11y.spec.ts`
  - axe reports no serious/critical errors on the 6 screens
  - All main flows can be completed using only the keyboard

**Completion criteria**

- The UI checklist passes at all 3 sizes

## P3-09 Niche master data editor (schema 2.0)

- **Owner:** webapp
- **Dependencies:** P3-01, P3-02
- **Prototype screen:** 7
- **PRD reference:** none (new requirement from ADR 0003)

**Goal.** A 5-step form for editing all 17 sections of schema 2.0; enforce minimum counts for each field as in the generator, with exactly 4 style_variants; show errors in the same format as the validator, with a "Fix" button that focuses the field; data statuses curated-draft, researched, validated; drafts autosave with the skill.edit permission.

**Proposed paths**

- `packages/core/src/skills/niche-schema.ts`
- `packages/core/src/skills/niche-rules.ts`
- `apps/web/src/app/(app)/skills/niche/[id]/page.tsx`
- `apps/web/src/features/skills/niche-editor/`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/core/test/skills/niche-schema.test.ts`
  - occasions with 6 records: error requires at least 8 records; found 6
  - style_variants with 5 records: error requires exactly 4
  - qa_rules.max_colors 13: error expected an integer from 1 to 12
  - A color palette contains #00FF00: rejected
  - Sample data teacher-example-data.json: valid
- `apps/web/test/e2e/niche-editor.spec.ts`
  - The "Fix" button jumps to the correct step and focuses the field with the error
  - The build button is disabled while errors remain
  - No horizontal overflow at 1024, 760, 390px

**Completion criteria**

- The minimum-count rules in the UI and the Python validator produce the same results on the sample dataset

---

## P3-10 Market-fit scoring and skill version builds from master data

- **Owner:** webapp + worker team (ngatruong123)
- **Dependencies:** P3-09
- **Prototype screen:** 7
- **PRD reference:** none (new requirement from ADR 0003)

**Goal.** Score 6 criteria from 1 to 5 (clarity, gift suitability, emotion, distinctiveness, potential for a collection, IP safety), with a maximum of 30; 25 or more: proceed, 21: revise, 16: rework, 15 or less: replace; IP below 4 always blocks. A build calls the generator as a worker job with a timeout and produces an immutable skill_version that is not yet published.

**Proposed paths**

- `packages/core/src/skills/market-fit.ts`
- `apps/jobs/src/skills/build-niche-skill.ts`
- `packages/contracts/schemas/niche-master-data.schema.json`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/core/test/skills/market-fit.test.ts`
  - 26 points, IP 5: Proceed
  - 24 points: Revise
  - IP 3 despite a total of 27: Block
  - 15 points: Replace
- `apps/jobs/test/skills/build-niche-skill.test.ts`
  - The generator exceeds the timeout: the job fails with a clear error; no version is created
  - A build succeeds: a new version has draft status and is not automatically published

**Completion criteria**

- Every skill version built from master data can be traced to its master data revision and scores

---

## P3-11 OpenBao secret store for subscription accounts and automatic re-login

- **Owner:** webapp + worker team (ngatruong123)
- **Dependencies:** P3-04, P3-05
- **Prototype screen:** 6
- **PRD reference:** none (new requirement from ADR 0003)

**Goal.** Store subscription account credentials (ChatGPT, Claude, Grok, Gemini, and other services) in OpenBao KV v2, with TOTP through the totp secrets engine. Workers authenticate with AppRole and receive secrets through single-use response wrapping. When account_state becomes session_expired, the worker automatically logs in again; captcha or device verification changes the status to awaiting human intervention and alerts admins. The webapp sees only metadata, never secret values.

**Proposed paths**

- `infra/openbao/policies/worker-accounts.hcl`
- `infra/openbao/docker-compose.openbao.yml`
- `packages/contracts/schemas/account-credential-ref.schema.json`
- `apps/web/src/features/accounts/credential-status.tsx`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/core/test/accounts/credential-ref.test.ts`
  - The webapp API returns account metadata without secret values
  - A wrap token is used a second time: rejected
  - The worker policy cannot read another store's paths
- `apps/web/test/e2e/account-relogin.spec.ts`
  - session_expired: the worker reports a successful re-login, and the status returns to available
  - A captcha is encountered: status changes to awaiting human intervention; admins receive an alert

**Completion criteria**

- No passwords, cookies, or TOTP seeds are stored in Postgres, logs, or job payloads
