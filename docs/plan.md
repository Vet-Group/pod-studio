# Plan: internal web app "POD Studio" (v0.3)

> Status: **product code has not been implemented**. Date: 2026-09-30.
> v0.2 replaces v0.1 (archived in `docs/plan-v0.1-archive.md`) based on the decisions the project owner finalized today.
> v0.3 adds: finalized library scope (designs per store, shared skills), screen 7 for editing niche master data, market-fit scoring, and the OpenBao secret store for subscription accounts (ADR 0003, tasks P3-09 to P3-11).
> Source: `prd-rebuild.md` (shared PRD, kept outside this repo) is the shared business reference document. **There is no `storekit` or `mockup-worker` repo**, so there is no code to port, no data to migrate, and no legacy system requiring compatibility.
> Web team scope: webapp, API, DB, scheduler. Worker team (ngatruong123) scope: workers (browser/API) and skills runtime.

All artifacts are in the repo root (`.`):

| Directory | Contents |
|---|---|
| `docs/adr/0001-stack.md` | Finalized stack, including a Preact Signals assessment |
| `docs/adr/0002-access-model.md` | Accounts, invites, store-scoped permissions |
| `docs/adr/0003-niche-skill-builder.md` | Niche master data, skill version builds, market-fit scoring, OpenBao |
| `packages/contracts/` | Worker API v2 (OpenAPI 3.1) + JSON Schema skill manifest, with examples and a self-check script |
| `design/wireframes/` | Prototype of 7 main screens (offline HTML) |
| `tasks/` | Detailed P1-P3 tasks with file paths and tests, plus `tasks.json` |

---

## 1. Finalized decisions (2026-09-30)

| Topic | Decision |
|---|---|
| Legacy repos | Ignore `storekit`, `mockup-worker`. Use the PRD only as a business requirements source. |
| Scale | No fixed number of users or AI accounts. Design for horizontal scaling (more workers, more accounts) without schema changes. Do not promise "unlimited" capacity; P3 measures load against specific profiles. |
| Sign-in | No SSO. Email + password. Admins create accounts (temporary password, mandatory change at first sign-in) or send invite links for users to enter their own information. SMTP is not required: links can be copied and sent through chat. |
| Push permission | Scoped by **store**, not company. Each store has exactly 1 owner (leader). Only the owner and people granted permission by the owner can push or publish. A leader can own multiple stores. System admins do **not** automatically have push permission. |
| Quotas, budgets | **Not in scope.** Only record `usage_events` (store, requester, store owner at that time) for future cost allocation by store or leader. |
| Stack | Next.js + React + TypeScript + Tailwind v4 + shadcn/ui + Drizzle + Postgres + better-auth + pg-boss. Details and rationale: ADR 0001. |
| Preact Signals | Not adopted yet. Rationale in §3. |
| Library scope | Designs, mockups, and redesigns are **store-scoped**; sharing with another store is a separate action. The **skill library is shared company-wide**: anyone with `skill.edit` can author drafts, only those with `skill.publish` can publish. |
| Niche master data | Edit in the webapp using the generator's schema 2.0, build immutable skill versions, do not publish automatically. Details in §7b, ADR 0003. |
| Subscription account secrets | Store in OpenBao (KV v2 + TOTP engine); workers retrieve them through AppRole and response wrapping, and automatically sign in again when sessions expire. Postgres stores metadata only. |

## 2. What to reuse from the PRD

| PRD section | Decision |
|---|---|
| §4.1-4.4 catalog, pricing, product, variant, translation, store_products | Rebuild according to the PRD schema, adding `store_id` scope and creator information |
| §6.2-6.6 price tables, SEO, product creation, 14-step push, import | Rewrite according to the specification, retaining the 20 invariants in §20 as test cases |
| §7 Shopify Admin GraphQL | Retain the API calling approach and idempotency |
| §5.1 job state machine | Replace with lease + heartbeat + error class (contract v2) |
| §8.5 worker API | Replace with Worker API v2 (the PRD itself identifies 3 weaknesses: no heartbeat, shared token, shared filesystem) |
| §8.4 agent API | Defer until after P3; if implemented, use a separate scoped token for each agent |
| §1.2, §10 `APP_PASSWORD` | Replace with accounts + store-scoped permissions |
| §13 shared filesystem | Replace with object storage + presigned URLs |
| §6.7-6.10 store-wide translation, audit, blog, theme | Outside the MVP |

## 3. Stack and Preact Signals

Choose Next.js because it has the largest ecosystem for the required toolset (shadcn/ui, better-auth, Drizzle, TanStack Query), many production examples, and makes hiring and AI assistance easier. Weekly npm downloads measured today: next 70.0 million, @tanstack/react-start 20.0 million. Business logic resides in framework-independent TypeScript in `packages/core`, so a future framework change will not require rewriting the core.

**`preactjs/signals`**, reviewed the `packages/react` README and npm figures:

- Supports React 16.14 to 19 (version 3.12.0).
- Automatic re-rendering requires the `@preact/signals-react-transform` Babel plugin. Next.js compiles with SWC, so this requires an additional Babel step or manual `useSignals()` calls in each component.
- The README lists limitations: signals cannot be passed to DOM attributes; render props and getters may not be tracked; components rendered through SSR do not track signals.
- About 0.35 million downloads/week, compared with about 65 million for zustand.

Conclusion: **not adopted yet.** Heavy screens (review grids with hundreds of images, the design library, upload queues) use virtual lists + zustand selectors, sufficient to re-render only the changed cell. Reconsider only when profiling shows a real bottleneck.

## 4. Architecture

```
Users (owner, co-leader, seller support, seller, designer, admin)
   │ email + password, sessions stored in Postgres
   ▼
apps/web  Next.js: UI, Server Actions, /api/worker/v2/*, SSE
   │                       ▲
   ▼                       │ presigned URL
Postgres ◄──── apps/jobs (pg-boss): Shopify push, lease reaper, notifications
   ▲
   │ HTTP Worker API v2 (register, claim, heartbeat, uploads, complete, fail)
AI workers from the worker team (ngatruong123) (chatgpt@accN, grok@accN, gemini-api, ...) on 1 or more machines
   │
Object storage (MinIO dev; MinIO or Cloudflare R2 prod)
```

- Workers do not read the DB or the webapp filesystem.
- AI jobs use a dedicated lease table, claimed over HTTP with `FOR UPDATE SKIP LOCKED`. pg-boss is for internal jobs only.
- Claim order: priority tier, then round-robin by **store**, then by requester, then oldest job first. One person submitting 200 designs does not block the entire queue.
- AI account credentials reside on worker machines; the webapp only knows account metadata and health.

Monorepo:

```
apps/web            Next.js
apps/jobs           Node + pg-boss
packages/core       access, catalog, pricing, seo, push, generation, skills
packages/db         Drizzle schema + migrations
packages/contracts  Worker API v2 + skill manifest (draft available)
packages/ui         tokens + customized shadcn components
tools/fake-worker   fake worker for end-to-end tests without a browser
```

## 5. Accounts and permissions (ADR 0002 summary)

- System-wide roles: `admin` (manage users, AI accounts, workers, skill publishing) and `member`.
- Store-scoped permissions: one row in `store_members(store_id, user_id, role, permissions[])`. Roles are presets: `owner`, `co_leader`, `seller_support`, `seller`, `designer`, `viewer`. Owners toggle individual permissions.
- `product.push` (push to Shopify as a draft) and `product.publish` (set active status, enable sales channels) are 2 separate permissions. Only owners can grant `product.publish`.
- No one can grant permissions they do not have. The last owner cannot be deleted or demoted.
- Users with `product.edit` but without `product.push` see the **"Send push request"** button instead of "Push".
- The server rechecks permissions when executing a push. If permission is revoked midway, the job stops.
- Permission checks are in `packages/core`; the UI only reflects them.
- Invites: random tokens, stored as hashes, usable 1 time, expire after 7 days, revocable.

## 6. Worker API v2 (draft available)

See `packages/contracts/README.md`. Key points for the worker team (ngatruong123) to review:

- Workers claim on behalf of 1 AI account; lease 180 seconds, heartbeat 45 seconds, long-poll 25 seconds.
- Files use presigned URLs, with sha256 verified on both input and output; workers reject URLs outside `storageOrigins` (SSRF protection).
- 7 error classes determine retries, whether attempts count, and account status (cooldown, session expiry).
- `complete`/`fail` are idempotent by `Idempotency-Key`; cancellation wins over completion when the 2 commands race.
- Prompts are pre-rendered from the skill version; workers do not need a template engine.
- 3 skill types share 1 manifest: `prompt_template`, `provider_skill` (for example `@create-wall-art-mockups`), `niche_agent`.

Verified by automated checks: `npm run check` (redocly lint with 0 warnings, 30/30 validation cases including 9 intentionally invalid cases rejected, TypeScript types generated), and `tsc --strict` on the type-check file.

## 7. Seven main screens (wireframes)

| # | Screen | Primary users | Contents |
|---|---|---|---|
| 1 | Design library | designer | Design library, bulk upload, mockup/redesign job creation, queue |
| 2 | Design review | designer, seller | Original design beside results, A/R/arrow keyboard shortcuts, bulk approval, rejection reasons |
| 3 | Listing content | seller | Product analysis, multilingual content generation and editing, duplicate keyword warnings |
| 4 | Products & push | seller, owner | Variants from price tables, dry-run, push draft, publish (permission required) |
| 5 | Stores & members | owner | Store selection, members, permission toggles, invites |
| 6 | Skills & operations | admin, skill authors | Library of 3 skill types, AI accounts (including re-login status), workers |
| 7 | Niche data | skill authors, publishers | 5-step niche master data editor, validator with a Fix button, scoring on 6 criteria, skill version builds |

Automated checks: `node design/wireframes/test-wireframes.mjs` passed 109/109 (navigation, keyboard shortcuts, permissions, minimum rules and scoring on screen 7, no horizontal overflow at 1024/760/390 on all 7 screens, WCAG AA contrast, minimum font size 11px, minimum click target 32px in all 3 visual directions and 44px at 390px).

## 7b. Niche master data and skill builds (ADR 0003 summary)

- The source of truth is master data JSON schema 2.0; skill versions are build outputs traceable to the master data version and scores.
- 17 sections, divided into 5 steps. All lists specify **minimums**; only `style_variants` requires **exactly 4**:
  - Step 1: basic information, `niche_profile` (6 fields), data sources (at least 1, statuses `curated-draft`, `researched`, `validated`), 8 personas, 5 buyer-recipient pairs.
  - Step 2: 8 purchase occasions, 6 emotions, 6 buyer language entries.
  - Step 3: 10 motifs, 3 color palettes, 3 typography styles, 4 layouts, 5 suitable products, 4 personalization fields.
  - Step 4: 8 hooks, 6 sample briefs, market-fit scoring thresholds.
  - Step 5: exactly 4 style variants, IP safety (5 items to avoid, 3 alternative pairs, 3 flags requiring human review), QA rules as 1 object (background `#00FF00`, aspect ratio `3:4`, color count 1 to 12).
- Market-fit scoring: 6 criteria scored 1 to 5 (clarity, gift suitability, emotion, differentiation, collection potential, IP safety), maximum 30. 25 or above: proceed; 21: revise; 16: rework; 15 or below: replace. IP below 4 always blocks.
- Errors use the same wording as the generator (`occasions: requires at least 8 records; found 6`). The generator remains the final authority: a shared fixture set must produce identical results in the TypeScript rules and Python script.
- The generator's license in the shared version is unclear; build jobs call the script from the skill pack, without copying code into the repo until clarified.

## 8. Roadmap

| Phase | Goal | Acceptance |
|---|---|---|
| **P0** (in progress) | Wireframes, contract, ADRs, task breakdown | Worker team (ngatruong123) approves the contract; the project owner approves the wireframes |
| **P1 Foundation + Studio** | Monorepo, auth + invites, store permissions, audit log, object storage, lease table + Worker API v2, fake-worker, Design library, Design review | Complete thin slice: invite a user, upload, create a job, fake-worker returns images, approve; no real worker required |
| **P2 Listing + Shopify** | Analysis, content, catalog, price tables, product creation, push dry-run/draft/publish, import | Real push to a dev store: correct variants, prices, markets, translations; PRD §20 invariants become tests |
| **P3 Skills + operations** | Skill lifecycle, AI account/worker screen, security hardening, load measurement, niche master data editing and skill builds, OpenBao for subscription accounts | Load figures for specific profiles; security checklist passed; skill builds from sample master data match the generator; expired accounts automatically sign in again or switch to waiting for human intervention |

Task details: `tasks/` (32 tasks: P1 11, P2 10, P3 11; `node tasks/validate-tasks.mjs` passed).

## 9. Risks

| Risk | Mitigation |
|---|---|
| Real workers lag behind the webapp | fake-worker follows the exact contract; P1 does not depend on real workers |
| Subscription accounts are locked or sessions expire | Separate error classes; workers retrieve passwords and TOTP codes from OpenBao to sign in again automatically; captcha or device verification switches to waiting for human intervention and notifies admins |
| Subscription account password exposure | Only OpenBao stores the values; jobs carry `credential_ref`; wrap tokens can be used 1 time; Postgres, logs, and payloads never contain secrets |
| Editor rules diverge from the generator | Shared fixtures run against both TypeScript rules and the Python script in CI; the generator is the final authority |
| Incorrect push to a real store | Mandatory dry-run, draft by default for the first push, separate publish permission, permission recheck at execution |
| Public repo exposes credentials | Do not commit secrets; pre-commit blocks sensitive config files |

## 10. Open questions (do not block P1)

1. Who can create new stores: only admins, or leaders granted `store.create` by admins?
2. Domain and production hosting (1 VPS or multiple machines)? This affects object storage (self-hosted MinIO or R2).
3. Is real email needed (self-service password recovery), or are admin-sent reset links through chat sufficient?
4. Will OpenBao run on the webapp machine or a separate machine, and who holds the unseal key? This affects P3-11.
