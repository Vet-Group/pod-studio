# P2 Listing and Shopify

Goal: create products from approved images using the correct price table, generate content, require a dry-run, push drafts, and publish under a separate permission; turn the PRD §20 invariants into tests.

> All tests below: **PLANNED - not implemented, not executed**. Paths are proposed and relative to the monorepo root.

| ID | Task | Owner | Dependencies | Screen |
|---|---|---|---|---|
| P2-01 | Product analysis | webapp | P1-07, P1-10 | 3 |
| P2-02 | Generate and edit multilingual listing content | webapp | P2-01, P2-04 | 3 |
| P2-03 | Catalog: product types, price tables, variants | webapp | P1-04 | 4 |
| P2-04 | Create products from approved results | webapp | P1-10, P2-01, P2-03 | 4 |
| P2-05 | Shopify connection: encrypted credentials and client | webapp | P1-04 | 5 |
| P2-06 | Push dry-run and snapshots | webapp | P2-02, P2-04, P2-05 | 4 |
| P2-07 | Push draft: execution, permission recheck, idempotency, reconcile | webapp | P2-06 | 4 |
| P2-08 | Publishing: active status, sales channels, markets | webapp | P2-07 | 4 |
| P2-09 | Push request queue | webapp | P2-06, P1-04 | 4 |
| P2-10 | Import and resync from Shopify | webapp | P2-03, P2-05 | 4 |

---

## P2-01 Product analysis

- **Owner:** webapp
- **Dependencies:** P1-07, P1-10
- **Prototype screen:** 3
- **PRD reference:** none (new requirement from ADR/contract)

**Goal.** A product_analysis job per the contract: input is design + niche + optional competitor link; output is audience, occasions, primary/secondary keywords, selling angles, product type and price suggestions, and IP warnings. The result provides context for content.

**Proposed paths**

- `packages/core/src/analysis/analysis.ts`
- `packages/db/src/schema/product-analyses.ts`
- `apps/web/src/app/(app)/listing/[designId]/analysis/page.tsx`
- `apps/web/src/features/listing/analysis-panel.tsx`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/core/test/analysis/analysis.test.ts`
  - Payload does not match the ProductAnalysisPayload schema: job status is failed with input_invalid, no invalid data is stored
  - IP warnings with severity high are displayed prominently but do not block actions
- `tests/e2e/analysis.spec.ts`
  - Run analysis with fake-worker; all result sections are displayed

**Done criteria**

- Analysis can be attached to a content job as context

---

## P2-02 Generate and edit multilingual listing content

- **Owner:** webapp
- **Dependencies:** P2-01, P2-04
- **Prototype screen:** 3
- **PRD reference:** §6.3

**Goal.** A listing_content job per locale; locale comes from params, not the payload; pass the list of primary keywords already used in the store; the editor has SEO limit counters, per-field regeneration, and version history; manual edits take precedence over newly generated content.

**Proposed paths**

- `packages/core/src/listing/content.ts`
- `packages/core/src/listing/seo.ts`
- `packages/db/src/schema/listing-contents.ts`
- `apps/web/src/app/(app)/listing/[productId]/page.tsx`
- `apps/web/src/features/listing/content-editor.tsx`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/core/test/listing/content.test.ts`
  - Payload specifies a locale different from params: save using params
  - Primary keyword duplicates a keyword already used in the store: show a warning
  - Manual edits are not overwritten by a later generation job
- `packages/core/test/listing/seo.test.ts`
  - Turn the SEO rules from PRD §6.3 into table-driven tests
- `tests/e2e/listing.spec.ts`
  - Edit the title, the counter updates, save, and the edit persists after reload

**Done criteria**

- Each locale has valid content before push is allowed

---

## P2-03 Catalog: product types, price tables, variants

- **Owner:** webapp
- **Dependencies:** P1-04
- **Prototype screen:** 4
- **PRD reference:** §4.2, §6.2

**Goal.** Store-scoped product_types and pricing_rules; variants are generated from the price table, not a Cartesian product; order follows sort_order; excluded_markets is defined per price row. Only users with store.settings can edit.

**Proposed paths**

- `packages/db/src/schema/catalog.ts`
- `packages/core/src/catalog/product-types.ts`
- `packages/core/src/catalog/pricing.ts`
- `apps/web/src/app/(app)/stores/[storeId]/catalog/page.tsx`
- `apps/web/src/features/catalog/pricing-table.tsx`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/core/test/catalog/pricing.test.ts`
  - Variant count exactly matches the number of price table rows, in sort_order order (invariant §20.1)
  - Price row missing an option required by the type: rejected
  - Users without store.settings cannot edit the price table

**Done criteria**

- The price table is editable in table form, with validation

---

## P2-04 Create products from approved results

- **Owner:** webapp
- **Dependencies:** P1-10, P2-01, P2-03
- **Prototype screen:** 4
- **PRD reference:** §6.4, §5.3

**Goal.** Select a design + approved images and a product type; SKU is the design filename without its extension; the design image is featured; product stage is derived per PRD §5.3, calculated in batches rather than N+1 queries.

**Proposed paths**

- `packages/core/src/products/create.ts`
- `packages/core/src/products/stage.ts`
- `packages/db/src/schema/products.ts`
- `apps/web/src/app/(app)/products/page.tsx`
- `apps/web/src/features/products/create-product-drawer.tsx`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/core/test/products/create.test.ts`
  - SKU equals the filename without its extension and is identical across all variants (invariant §20.11)
  - Only approved images can be selected
  - Repeated creation from the same source: no duplicate product is created
- `packages/core/test/products/stage.test.ts`
  - Turn the deriveStage branches from PRD §5.3 into table-driven tests
  - Stages for a list of 200 products are calculated with a fixed number of queries

**Done criteria**

- Created products have all variants, images, and SKUs

---

## P2-05 Shopify connection: encrypted credentials and client

- **Owner:** webapp
- **Dependencies:** P1-04
- **Prototype screen:** 5
- **PRD reference:** §7, §6.1

**Goal.** Store client_secret and access token using AES-256-GCM (versioned key from env); a Shopify Admin GraphQL client with throttle handling; a Test connection button; a deterministic Shopify stub for tests.

**Proposed paths**

- `packages/core/src/shopify/client.ts`
- `packages/core/src/shopify/crypto.ts`
- `packages/core/src/shopify/connect.ts`
- `packages/db/src/schema/shopify.ts`
- `tests/support/shopify-stub.ts`
- `apps/web/src/app/(app)/stores/[storeId]/settings/page.tsx`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/core/test/shopify/crypto.test.ts`
  - Encryption and decryption round-trip correctly; changing 1 byte of ciphertext causes decryption to fail
  - Logs and errors never contain secrets (string scan)
- `packages/core/test/shopify/client.test.ts`
  - Shopify throttles a request: wait and retry with a limit
  - Only the owner or users with store.settings can view/edit credentials

**Done criteria**

- No plaintext secrets in the DB, logs, or responses

---

## P2-06 Push dry-run and snapshots

- **Owner:** webapp
- **Dependencies:** P2-02, P2-04, P2-05
- **Prototype screen:** 4
- **PRD reference:** §6.5, §7.4

**Goal.** Dry-run builds the complete push input (productSet, media, translations, markets, sales channels) from a content snapshot taken at the time of the click, compares it with existing Shopify data, and displays a diff. Changing prices or content after dry-run invalidates the dry-run.

**Proposed paths**

- `packages/core/src/push/plan.ts`
- `packages/core/src/push/snapshot.ts`
- `packages/core/src/push/diff.ts`
- `apps/web/src/features/products/push-panel.tsx`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/core/test/push/plan.test.ts`
  - Snapshot locks content at push time (invariant §20.10)
  - Change prices after dry-run: the dry-run is marked stale and push is blocked
  - Dry-run does not call any mutations on the Shopify stub

**Done criteria**

- Push is blocked without a valid dry-run

---

## P2-07 Push draft: execution, permission recheck, idempotency, reconcile

- **Owner:** webapp
- **Dependencies:** P2-06
- **Prototype screen:** 4
- **PRD reference:** §5.4, §6.5, §7.4, §12

**Goal.** Push jobs run in apps/jobs (pg-boss); the first push defaults to draft; recheck product.push at execution and before each store; on timeout after a Shopify write, read back to reconcile rather than retry blindly; record an event for every step.

**Proposed paths**

- `apps/jobs/src/push/run-push.ts`
- `packages/core/src/push/execute.ts`
- `packages/core/src/push/reconcile.ts`
- `packages/db/src/schema/push-jobs.ts`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/core/test/push/execute.test.ts`
  - Permission is revoked during a job: stop before the next store and record an event
  - Admin without the permission: rejected
  - Match variants using variantOptionKey, not index (invariant §20.2)
  - Media: attach new images before deleting old images (invariant §20.6)
  - The first push defaults to draft (invariant §20.9)
- `packages/core/test/push/reconcile.test.ts`
  - Stub times out after creating a product: the job reads back using handle/idempotency key and does not create a 2nd product
  - pg-boss redelivers a message: a job already in a terminal state exits immediately

**Done criteria**

- Push 1 product to a Shopify dev store (separate gate, requires credentials) with the correct variants, prices, and images

---

## P2-08 Publishing: active status, sales channels, markets

- **Owner:** webapp
- **Dependencies:** P2-07
- **Prototype screen:** 4
- **PRD reference:** §6.5, §20

**Goal.** Separate product.publish permission; a confirmation dialog that requires the checkbox to be checked; recheck permission at execution; market exclusions fail closed; other non-market sales channels are unpublished when the type specifies this. A test suite for the push-related PRD §20 invariants.

**Proposed paths**

- `packages/core/src/push/publish.ts`
- `packages/core/src/push/markets.ts`
- `apps/web/src/features/products/publish-confirm-dialog.tsx`
- `packages/core/test/push/invariants/`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/core/test/push/publish.test.ts`
  - Has product.push but not product.publish: rejected
  - seller_support has not been granted publish by the owner: rejected
  - Owner revokes publish after the job is queued: the job stops at execution
- `packages/core/test/push/invariants/markets.test.ts`
  - Market exclusions fail closed (invariant §20.3)
  - Other non-market channels are unpublished (invariant §20.4)

**Done criteria**

- Every push-related §20 invariant has a corresponding test

---

## P2-09 Push request queue

- **Owner:** webapp
- **Dependencies:** P2-06, P1-04
- **Prototype screen:** 4
- **PRD reference:** none (new requirement from ADR/contract)

**Goal.** Users with product.edit but not product.push see a Submit push request button; requests include a dry-run; users with product.push in the store approve or return requests with a reason; notifications are provided.

**Proposed paths**

- `packages/core/src/push/requests.ts`
- `packages/db/src/schema/push-requests.ts`
- `apps/web/src/app/(app)/products/requests/page.tsx`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/core/test/push/requests.test.ts`
  - Requesters cannot approve their own requests without product.push
  - If a request's dry-run is stale, it must be rerun before approval
- `tests/e2e/push-request.spec.ts`
  - Seller submits a request, the owner sees it in the queue, and approval starts the push job

**Done criteria**

- No push path bypasses a user with the required permission

---

## P2-10 Import and resync from Shopify

- **Owner:** webapp
- **Dependencies:** P2-03, P2-05
- **Prototype screen:** 4
- **PRD reference:** §6.6

**Goal.** Import existing Shopify products into the catalog; resync variants from the price table; preserve SKU during resync.

**Proposed paths**

- `packages/core/src/shopify/import.ts`
- `packages/core/src/catalog/resync.ts`
- `apps/jobs/src/shopify/import-job.ts`

**Planned tests** (PLANNED - not implemented, not executed)

- `packages/core/test/shopify/import.test.ts`
  - Importing 2 times does not create duplicates
  - Resync preserves SKU (invariant §20.11)
  - Users without store permission cannot import

**Done criteria**

- Import runs in the background with progress and logs
