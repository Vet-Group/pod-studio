# Plan: internal web app "POD Studio" based on the storekit PRD (draft v0.1)

> Status: draft for discussion, **not implemented**. Date: 2026-09-30.
> Sources reviewed: `prd-rebuild.md` (shared PRD, kept outside this repo) (storekit + mockup-worker), `ngatruong123/redesign`, `ngatruong123/remakeai`, `Vet-Group/pod-skill-builder`.
> Not yet accessible: the `storekit` and `mockup-worker` repos (not found under ngatruong123, Vet-Group, huuhungn). All assessments of these 2 repos are based on the PRD.
> Web team scope: Webapp, API, DB, scheduler, quota. Worker team (ngatruong123) scope: workers (browser/API) and skills runtime.

---

## 0. Assessment: can the PRD serve as the foundation?

**Yes, but use the PRD as a "domain spec", not as the architecture.** The PRD is strong on Shopify business logic (it already has invariants, idempotency, state machines, test cases), but was written for **1 operator, 1 machine, 1 password**. These three assumptions conflict with the project's requirements.

| PRD section | Decision | Rationale |
|---|---|---|
| §4.1-4.4 catalog, pricing, products, variants, translations, store_products | **Retain almost unchanged**, add owner/team columns | Stable and tightly coupled to push logic |
| §6.2-6.6 price tables, SEO, product creation, 14-step push, import | **Retain the logic unchanged** | The most valuable and error-prone part; §20 invariants must be preserved |
| §7 Shopify integration | **Retain** | |
| §5.1 mockup_jobs state machine | **Retain transitions, add** lease/heartbeat, error_class, quota status | Multiple users require a fair queue |
| §8.5 internal worker API | **Retain for v1 compatibility**, design v2 | Keep the current mockup-worker running during the transition |
| §8.4 agent API | **Retain**, change auth to scoped per-agent tokens | |
| §1.2, §10 `APP_PASSWORD` auth, stateless sessions | **Replace entirely** | Users, roles, and session revocation are required |
| §13 shared filesystem, "same machine" constraint in §1.3 | **Replace** with object storage + presigned URLs | Workers must run across multiple machines/IPs |
| §15 shared `WORKER_TOKEN`/`AGENT_TOKEN` in env | **Replace** with per-worker/agent credentials in the DB | Revocation and individual worker traceability |
| §16 mockup-worker | **Owned by the worker team (ngatruong123)**, the webapp only maintains the contract | |
| §6.7-6.10 translation, audit, blog, theme | **Defer until after the MVP** (ask Q8) | Does not directly serve designers/sellers |
| §11 UI | **Rewrite by persona**, retain §11.2 design tokens | The current UI is for 1 operator |

Estimate: about 60% of the PRD can be reused directly for `core`. The rest (identity, tenancy, quota, storage, skills, UX) requires a new design.

Answers to the 5 open questions in PRD §22 (proposals, awaiting the project owner's approval):

1. `<h3>` in descriptions: **no**, consistent with the current code. Put this rule in the content skill so it can change without code changes.
2. Worker heartbeat: **yes**, mandatory in v2 (see §6).
3. Error classes with `code` instead of regex: **yes**.
4. Fix store scope and the duplicate guard race: **yes**, implement immediately in the build.
5. Default mockup backend `chatgpt`: **yes**.

---

## 1. Goals and non-goals

**v1 goals**

1. Multiple concurrent users (designer, seller, leader, admin), with team- and store-scoped permissions.
2. Fair AI job scheduling across a limited number of accounts: quotas, priorities, a transparent queue.
3. Designer flow: upload → redesign/variation → mockup → approve.
4. Seller flow: product analysis → generate multilingual title/description/tags/SEO → edit → push to Shopify.
5. Skills: registry, editor, versions, test runs, workflow assignments.
6. A clear contract with workers/skills from the worker team (ngatruong123), compatible with running alongside the current mockup-worker.

**v1 non-goals**: selling external SaaS (multi-org, billing), marketplaces beyond Shopify, automatic push without a human click, storing ChatGPT/Grok credentials in the webapp.

---

## 2. Responsibility boundaries

| Item | Webapp (web team) | Worker/Skills (worker team, ngatruong123) | Shared |
|---|---|---|---|
| Auth, RBAC, team, store grants | ✓ | | |
| Job API, scheduler, quota, ledger | ✓ | | |
| Browser automation, account sign-in, profiles, proxies | | ✓ | |
| AI account credentials | | ✓ (worker machines only) | |
| Prompt/skill content | storage, versioning, distribution | authoring, verification | |
| Skill validator (Python) | invoke through jobs | ownership | |
| API contract (OpenAPI + JSON Schema) | | | ✓ `packages/contracts` |
| Object storage | issue presigned URLs | upload/download | |
| Shopify push | ✓ | | |

Merge rule: **no shared DB, no shared filesystem**. The two teams meet only at the HTTP contract and object storage. This removes stack differences as an issue (ngatruong123/redesign uses Next.js + Prisma, the PRD uses TanStack Start + Drizzle, workers use Python).

---

## 3. Proposed architecture

```
Users (designer / seller / leader / admin)
   │ SSO + DB sessions
   ▼
apps/web  (UI + server functions + REST /api/v2)
   │                                   ▲
   ▼                                   │ presigned URL
Postgres (app tables + pgboss.*) ◄── apps/jobs (Node, pg-boss)
   ▲                                   push, text-LLM, product analysis,
   │                                   reapers, scheduler tick, notify
   │ /api/v2/worker/*  (register, claim, heartbeat, complete, fail, account-status)
   │
AI workers (worker team, ngatruong123): chatgpt@accN, grok@accN, gemini-api, ...
   │ run on 1 or more machines
   ▼
Object storage (self-hosted MinIO or Cloudflare R2)
```

Principles:

- Workers do not read the DB or the webapp filesystem. Remove the "same machine" constraint from PRD §1.3.
- The server decides which job runs next (scheduler). Workers only claim according to the capabilities of the accounts they hold.
- AI account credentials reside on worker machines. The webapp only knows account metadata and health.
- `packages/core` is framework-independent TypeScript, as in PRD §3, for porting push/SEO logic.

Monorepo:

```
apps/web             TanStack Start (or Next.js, see Q6)
apps/jobs            Node + pg-boss
packages/core        catalog, pricing, seo, push, generation, quota, skills, rbac
packages/db          drizzle schema + migrations
packages/contracts   OpenAPI worker v2 + JSON Schema skill manifest → generate TS types + Pydantic
packages/skill-schema  niche master data schema (shared with POD Skill Studio if the team agrees)
packages/ui          design tokens (PRD §11.2) + shadcn
tools/fake-worker    fake worker for scheduler/quota tests, no Chrome required
```

---

## 4. Users and permissions

Model: 1 Organization (company) → multiple Teams (for example Wall Art, Apparel) → Users. Stores are granted to teams, with per-user overrides available.

| Role | Main permissions |
|---|---|
| Admin | users, teams, stores, Shopify credentials, provider accounts, quota policies, skill publishing, access to all audits |
| Leader | manage team members, approve designs/listings, set job priorities, view team KPIs and usage, push |
| Designer | upload designs, redesign, mockup, approve images, use published skills, create skill drafts (if granted) |
| Seller | analyze products, create products, edit content, preview, push to granted stores |
| Viewer | read-only |

- Permissions are strings (`job.create`, `job.priority.set`, `result.approve`, `product.create`, `product.push`, `store.manage`, `skill.edit`, `skill.publish`, `quota.manage`, `account.manage`, `user.manage`). Roles are sets of permissions. Check in `core`, not just in the UI.
- All store-related queries go through `assertStoreAccess(principal, storeId, perm)`, plus the store-scope guards from PRD §4.6.
- Service principals: `worker` (one token per worker, stored as a hash, scope `worker:*`) and `agent` (diprr, limited scope, separate `push_allowed` flag). Replace the shared `WORKER_TOKEN`/`AGENT_TOKEN`.
- Auth: SSO (Google Workspace or Lark OAuth, see Q3), with email invite + password as a fallback. Sessions are stored in the DB for revocation.
- Add `actor_user_id`, `actor_kind` (user/agent/worker/system) to `activity_log`.

---

## 5. Quotas and account scheduling (focus)

### 5.1 Problem

- Subscription accounts (ChatGPT, Grok) have hidden limits with no published exact numbers, and frequently encounter cooldowns and expired sessions. One account processes one job at a time (PRD §16.2).
- APIs (Gemini, OpenAI, DeepSeek) have RPM/TPM limits and charge for usage.
- Pure FIFO: one person uploading 200 designs takes over the entire company's queue.

### 5.2 Concepts

- **`provider_account`**: a specific account (chatgpt-acc1, grok1, gemini-key-a). Has capabilities (mockup, redesign, content, analysis) and status `active | busy | cooldown(until) | session_expired | disabled`. Workers report status; admins enable/disable accounts.
- **Capacity unit**: normalized cost for each job type × backend pair, configurable. Initial examples: ChatGPT mockup = 10, browser content = 3, API content = 1. Do not hardcode provider limits; measure actual usage and adjust.
- **`quota_policy`**: scope (user | team | role) × job type/provider × window (day | month) → `limit_units`, `max_inflight`, `max_pending`.
- **`quota_ledger`**: reserve at enqueue, commit at completion, release on cancellation or errors not caused by the user.

### 5.3 Flow

1. **Enqueue**: check permissions → reserve quota → create a `pending` job (or `waiting_quota`), return queue position and estimated ETA.
2. **Claim** (worker call): the server selects by priority tier (`interactive` > `normal` > `bulk`) → round-robin by requester (those with the fewest running jobs go first) → `created_at`. Still uses `FOR UPDATE SKIP LOCKED` as in the PRD. Respects per-user and per-team `max_inflight`.
3. **Lease + heartbeat**: short `lease_expires_at` (for example 5 minutes), worker heartbeat every 60 seconds. The reaper uses the lease, not 30 minutes from `claimed_at`. ChatGPT flows running 15-20 minutes are no longer cut off incorrectly.
4. **Classified failures** with `error_class`:

   | error_class | Job handling | Account handling | Count attempt | Deduct quota |
   |---|---|---|---|---|
   | `account_rate_limited` (+ `retry_after_s`) | return to `pending` | cooldown | no | no |
   | `account_session_expired` | return to `pending` | `session_expired`, notify admin | no | no |
   | `provider_refused` | `failed`, ask the user to revise the prompt/design | unchanged | yes | yes (depending on policy) |
   | `transient` | retry with backoff | unchanged | yes | no |
   | `permanent` | `error_permanent` | unchanged | | no |

5. **Complete**: commit the ledger, store results, notify after commit (as in PRD §14).

### 5.4 Reduce quota consumption

- **Run text tasks through APIs**, not the ChatGPT browser. The PRD currently generates content through the browser (§16.6), taking slots from image-generation accounts. Move listing content and product analysis to LLM APIs in `apps/jobs`. Requires agreement from the worker team (ngatruong123) and API budget approval.
- **Mockup templates** (compositing with sharp/Fabric as in `ngatruong123/redesign`) for standard images (plain frames, flat lay): no AI quota consumption. Reserve AI for lifestyle scenes.
- **Cache/dedupe**: allow result reuse for identical `sha256(design) + skill_version + params`.
- **Off-hours bulk runs**: the `bulk` queue is prioritized at night, `interactive` during business hours.
- **Transparency**: users always see queue position, ETA, remaining quota, and why they are waiting.

---

## 6. Worker v2 contract (joint work with the worker team, ngatruong123)

v1 (PRD §8.5) continues running alongside the current mockup-worker, then is disabled in P9.

| Endpoint | Purpose |
|---|---|
| `POST /api/v2/worker/register` | workers declare id, host, version, accounts[], capabilities |
| `POST /api/v2/worker/claim` | `{worker_id, account_id, capabilities, job_types}` → `{job, inputs[presigned GET], skill:{id, version, manifest_url}, lease_expires_at}`; 204 when no jobs remain |
| `POST /api/v2/worker/jobs/:id/heartbeat` | renew lease, progress (optional), short log |
| `POST /api/v2/worker/jobs/:id/uploads` | request presigned PUT URLs for N outputs |
| `POST /api/v2/worker/jobs/:id/complete` | `{outputs:[{key, sha256, width, height, meta}]}` or `{payload}` for content; idempotent by key |
| `POST /api/v2/worker/jobs/:id/fail` | `{error_class, message, retry_after_s?}` |
| `POST /api/v2/worker/accounts/:id/status` | `{status, cooldown_until?, installed_skills?}` |

- The contract lives in `packages/contracts` (OpenAPI 3.1 + JSON Schema), generating TS types and Pydantic models. Contract tests run in both repos. Bump the version when changing the contract.
- `tools/fake-worker` enables independent webapp testing without depending on real worker progress.

---

## 7. Skills

### 7.1 Three existing "skill" types (confirmation needed in Q9)

| Type | Example | Where it runs | Webapp responsibility |
|---|---|---|---|
| Prompt template | `SCENE_PROMPTS` (poster, tshirt, mug...), `REDESIGN_PROMPT`, niche-specific content prompts (PRD §16.8-16.9) | Workers download by version | Storage, versioning, editor, workflow assignments |
| Provider skill | `@create-wall-art-mockups` must be installed on every ChatGPT account (PRD §16.8) | Within the ChatGPT account | Track which accounts have which versions installed, warn about missing installations |
| Niche design agent | Output of `Vet-Group/pod-skill-builder`: master data schema 2.0 → `SKILL.md` + zip | Agent/worker | Master data editor, validate, build, publish, distribute |

### 7.2 Data

- `skills` (kind, slug, name, niche, owner_team, visibility)
- `skill_versions` (semver, status `draft | in_review | published | deprecated`, manifest jsonb, artifact_key for zip, checksum, schema_version, changelog, created_by, published_by)
- `skill_bindings` (job type × product type × niche × backend → skill_version; company-wide defaults, per-team overrides)
- `skill_test_runs` (version, sample designs, job ids, approval rate)
- Published versions are **immutable**. Each job stores `skill_version_id` to trace which prompt generated each image.

### 7.3 UI-UX

- **Library**: filter by kind, niche, product type, status; show version, approval rate, owner.
- **Prompt template editor**: variables `{count}`, `{product_type}`; warn about `@skill` mentions (workers must type mentions with real keystrokes, PRD §16.6 step 6); preview the rendered prompt.
- **Niche agent editor**: section-based wizard as in POD Skill Studio (`app/src/lib/schema/sections.ts`, `types.ts`): personas, occasions, emotions, visual vocabulary...; `count/min` badges; cross-reference fields are dropdowns; fixed constants (background `#00FF00`, aspect ratio 3:4) are read-only; raw JSON tab.
- **Validate**: do not rewrite the validator in TS. Call `create_pod_design_skill.py --validate-only` through a `skill-validate` job (Python sidecar or worker), map errors to fields (reuse ideas from `parseValidatorOutput.ts`, `errorIndex.ts`).
- **Review and publish**: diff between 2 versions, Leader/Admin approval before publishing.
- **Test runs**: select 1-3 sample designs, run with a separate "sandbox" budget, compare with the current version (A/B).
- **Assign skills**: binding table, per-team rollout.
- **Quality KPI**: image result approval rate by skill version × backend (the `approved` column already exists in PRD §5.2). This data determines which prompts perform better.

Additional proposal: extract `packages/skill-schema` so POD Skill Studio (Tauri) and the web editor share one schema. Ask the pod-skill-builder team.

---

## 8. Persona-based UX

Navigation:

- **Studio** (designer): Designs, Redesign, Mockups, Review
- **Listing** (seller): Analyze, Products, Content, Push
- **Skills**
- **Team** (leader): Dashboard, Approvals, Usage
- **Admin**: Users & Teams, Stores, AI Accounts & Workers, Quota, Audit log

Main screens:

1. **Design library**: bulk upload (drag entire folders), sha256 dedupe, niche/product type/tag assignment, search, pipeline status for each design.
2. **Create job** (redesign/mockup): select designs, product type, skill (default from binding), quantity, "automatic" backend or a pinned backend; show unit cost, balance, ETA **before clicking**.
3. **My queue**: position, ETA, status, cancel, rerun; realtime through SSE instead of polling every 2-3 seconds.
4. **Review**: image grid, keyboard shortcuts (A approve, R reject, ←/→), beside the original design, bulk approval, rejection reasons (data for skill improvement).
5. **Product analysis** (seller): inputs are design/image + niche + (optional) competitor link. Outputs: audience, occasion, primary/secondary keywords, sales angles, IP/trademark warnings, suggested product type and price. Used as context for content.
6. **Listing studio**: create products from approved results (PRD §6.4); multi-locale editor with limit counters (SEO title 60, SEO description 155, 13 tags, handle); duplicate keyword warnings within the store; regenerate individual fields; content version history.
7. **Push**: preview/dry-run against Shopify, select publish status, requires `product.push`, Leader approval depending on policy.
8. **Leader dashboard**: design → mockup → listing → push throughput, approval cycle time, approval rate, quota usage by user/team, failed jobs.
9. **AI Accounts & Workers** (admin): account status, cooldown, expired sessions ("Signed in again" button), online workers, running jobs, skills installed on accounts.

---

## 9. Data: changes from the PRD

Retain the tables from PRD §4.1-4.4. Add:

```
users, sessions, invites, teams, team_members(role), role_permissions
store_grants(team_id | user_id, store_id, permissions[])
service_clients(kind worker|agent, name, token_hash, scopes, push_allowed, last_used_at, revoked_at)
assets(storage_key, sha256, mime, width, height, bytes, owner_user_id, team_id)
designs            + created_by, team_id, niche, tags, asset_id (replaces source_file)
generation_jobs    (= mockup_jobs) + requested_by, team_id, priority, cost_units,
                   lease_expires_at, account_id, skill_version_id, error_class,
                   not_before, idempotency_key, queue_state
generation_results (= mockup_results) + asset_id, approved_by_user_id, reject_reason
provider_accounts, workers (last_seen, version, current_job_id)
quota_policies, quota_ledger
skills, skill_versions, skill_bindings, skill_test_runs
product_analyses(design_id, input, output jsonb, model, created_by)
approvals(entity, entity_id, requested_by, decided_by, status)
activity_log       + actor_user_id, actor_kind
```

Retain PRD conventions: text nanoid PKs, no Postgres enums, `timestamptz`. Also fix the issues identified by the PRD: duplicate guard using unique `(store_id, source_job_id, result_set_hash)`; stage filtering before pagination; error classes instead of regex; add store scope to `rollbackThemeBackup`, `fixFindings`, `ignoreFinding`.

---

## 10. Roadmap

| Phase | Contents | Acceptance |
|---|---|---|
| **P0 Finalize** (about 1 week) | Answer §12; obtain access to the storekit/mockup-worker repos; contract meeting with the worker team (ngatruong123); wireframes for 6 main screens; finalize the stack | Contract v2 draft approved by 2 teams; wireframes approved; stack ADR |
| **P1 Foundation** | Monorepo, DB, SSO + invites, DB sessions, RBAC, teams, store grants, audit log, UI shell + tokens | Admin invites users, assigns roles; sellers cannot see stores they have not been granted (tested) |
| **P2 Asset + Design** | Object storage, presigned URLs, bulk upload, dedupe, design library | Upload 200 files without duplicates, with thumbnails |
| **P3 Scheduler + Quota** | generation_jobs, fair claims, lease/heartbeat, error_class, ledger, provider_accounts, workers page, v1 compatibility, fake-worker | 10 users × 50 jobs: no double claims; no one must wait for another person's entire batch; rate limits do not consume attempts; exhausted quota leads to `waiting_quota` |
| **P4 Designer studio** | Job creation, queue (SSE), review, approval | upload → mockup → approve works with fake-worker and 1 real worker |
| **P5 Catalog + Listing** | PRD P2 + P5: product types, price tables, product creation, content fan-out, editor, product analysis through APIs | Create products in N locales, stage `ready`, manual edits take precedence over generated content |
| **P6 Push** | 14-step logic from PRD P6 + permissions + approval policy | Dry run matches snapshots; dev store push satisfies all PRD §20 invariants |
| **P7 Skills** | Registry, versions, prompt template editor, niche wizard, validator sidecar, bindings, test runs | Publishing poster prompt v2 makes new jobs use v2, while old jobs still reference v1; approval rate available by version |
| **P8 Leader + Ops** | KPI dashboard, usage, notifications (Lark or Buzz), backup, monitoring, deployment waits for an idle queue | Leaders view usage by user; alert when an account is `session_expired` |
| **P9 Migration** | Import storekit prod data (if any) into the default team, retain ids; switch mockup-worker to v2; disable v1 | Row counts match; Shopify GIDs are preserved; repeat pushes return `skipped` |
| **P10 (optional)** | Translation, audit, blog, theme (PRD P8-P10) | Per the PRD |

Parallel work is possible: after P3, the worker team (ngatruong123) develops worker v2 using the contract and fake-worker, without waiting for the UI.

---

## 11. Risks

- **Terms of service**: automating consumer ChatGPT/Grok accounts may violate terms and result in account locks. Critical flows need an API fallback rather than depending on 1-2 accounts.
- **Changing hidden limits**: quotas must be configurable and adjusted based on actual rate-limit events.
- **Skills outside the system**: a ChatGPT account missing `@create-wall-art-mockups` generates incorrect images. Track installation per account.
- **Stack differences between the teams**: mitigate with an HTTP contract, no shared DB.
- **storekit prod data**: if it is running, migration must preserve Shopify GIDs and checksums to avoid duplicate products.
- **Secrets in the public repo**: see the security note included in chat.

---

## 12. Questions for the project owner

High priority (blocks P0):

1. **Repos and prod**: where are storekit and mockup-worker, and who owns them? Is storekit running in production with real data that needs migration?
2. **Scale**: how many designers, sellers, leaders? How many stores? How many designs per day? How many ChatGPT, Grok, Gemini accounts are available now, and how much growth is expected?
3. **Sign-in**: does the company use Google Workspace or Lark for SSO?
4. **Approval workflow**: who can push to Shopify? Do designs/listings require Leader approval before pushing? Can sellers see all stores?
5. **Quotas**: per person or per team? Are there priority levels (for example urgent orders)? Is there an API budget (Gemini/OpenAI) for fallback?
6. **Stack**: follow the PRD (TanStack Start + Drizzle + pg-boss), or Next.js + Prisma as in `ngatruong123/redesign`?

Medium priority:

7. **Infrastructure**: run on an Ubuntu + Tailscale host as in the PRD, or VPS/Cloudflare? MinIO or R2 for object storage?
8. **Scope**: are translation, audit, blog, theme needed in v1?
9. **Skills**: which of the 3 skill types in §7.1 does the worker team (ngatruong123) build? Is `Vet-Group/pod-skill-builder` (commits by willpine88, thienduy2211) the skills component to integrate?
10. **Notifications**: Lark or Buzz as in the PRD?
11. **Product analysis**: inputs are images, competitor links (Etsy/Amazon), or both? Which output fields are needed?
12. **Mockup templates**: add template-based composite mockups (no AI quota consumption) as in `ngatruong123/redesign`?

---

## 13. Defaults if no answers are provided

- Stack: TanStack Start + Drizzle + pg-boss, to maximize PRD reuse.
- Auth: Google Workspace SSO + invites.
- Storage: MinIO on the same host.
- Text tasks (content, analysis) run through APIs.
- Heartbeat and error classes included, default mockup backend `chatgpt`, descriptions do not start with `<h3>`.
- No translation, audit, blog, theme in v1.

---

## 14. Proposed next steps

1. The project owner answers Q1-Q6.
2. Draft `packages/contracts` (OpenAPI worker v2 + JSON Schema skill manifest) for review by the worker team (ngatruong123).
3. Wireframes for 6 screens: Design library, Create job, Review, Listing studio, Skills editor, AI Accounts & Workers.
4. Break P1-P3 into detailed tasks with file paths and tests.
