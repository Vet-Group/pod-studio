# @pod-studio/contracts (worker API v2, draft 2)

Contract between the **POD Studio webapp** and the **AI workers / skills runtime**.
Status: **draft for review**. Nothing is implemented yet. Field names, enums and timings are proposals.

| File | What it is |
|---|---|
| `openapi/worker-api.yaml` | OpenAPI 3.1: the HTTP API workers call |
| `schemas/common.schema.json` | Shared primitives: ids, sha256, locale, provider, asset/skill refs, error classes, problem details |
| `schemas/job.schema.json` | Params a worker receives and payloads it returns, per job type |
| `schemas/skill-manifest.schema.json` | Metadata for one immutable skill version (3 kinds) |
| `examples/worker/*` | One valid example per request/response |
| `examples/skills/*` | One valid manifest per skill kind |
| `examples/invalid/*` | Documents that must be rejected (negative tests) |
| `scripts/validate-examples.mjs` | Validates all examples; fails if an invalid fixture is accepted |

```bash
npm install
npm run check        # redocly lint + example validation + TypeScript type generation
```

Python side (suggestion, not verified here): generate Pydantic models from `schemas/` and the OpenAPI
components with `datamodel-code-generator`, and run the same `examples/` through them in the worker's CI.

---

## 1. Boundaries

- Workers never read the webapp database or filesystem. Files move only through **presigned URLs**.
- The **server** decides which job runs next. A worker claims **on behalf of one provider account**.
- **Provider credentials stay on the worker machine.** The webapp stores only account metadata
  (`accountKey`, provider, channel, job types, state, installed provider skills). Never send emails,
  cookies or tokens in any field, including `note` and `providerMeta`.
- Prompts arrive **already rendered** from a published skill version. Workers need no template engine.
  A prompt may contain a provider mention such as `@create-wall-art-mockups`, which the worker must type
  with real keystrokes so the provider UI resolves it.

## 2. Authentication and versioning

- `Authorization: Bearer <worker token>`: one token per worker process, issued and revoked by an admin,
  shown once, stored hashed.
- `X-Contract-Version: 2` on every call. "v2" means the successor of the reference PRD's single-host worker
  API (section 8.5: shared token, shared filesystem, fixed 30-minute cut-off). No v1 system is running, so
  there is nothing to stay compatible with.
- Additive changes (new optional fields, new enum values in open sets such as `Provider`) keep version 2.
  Breaking changes bump to 3; the server accepts N and N-1 during a transition window and answers
  `426 contract_version_unsupported` afterwards.
- Errors use RFC 9457 problem details with a stable `code`.

## 3. Lifecycle

```
worker start ─► POST /register  (accounts[] → accountId[], timings)
loop per account:
  POST /claim {accountId, waitSeconds≤25}  ── 204 ──► claim again
      │ 200 {job, leaseToken, leaseExpiresAt}
      ▼
  download inputs[] (presigned GET, verify sha256)
  every heartbeatIntervalSeconds: POST /jobs/{id}/heartbeat {leaseToken, progress}
      └─ cancelRequested=true → stop → POST /fail {errorClass:"cancelled"}
  image jobs: POST /jobs/{id}/uploads {files[]} → PUT each file → POST /complete {images[]}
  text jobs:  POST /complete {payload}
  on error:   POST /fail {errorClass, message, retryAfterSeconds?}
  409 lease_lost on any call → discard local work for that job, claim again
```

Default timings (returned by `/register`, tunable server-side): `leaseSeconds=180`,
`heartbeatIntervalSeconds=45`, `maxClaimWaitSeconds=25`. A job has a hard `timeoutSeconds` ceiling on top
of the lease. The longest known flow (browser image generation with provider waits) is covered by
heartbeats, not by a long lease.

Model and output size (added in draft 2):

- `job.model` is the provider model the requester chose (open id, for example `nano-banana-pro`). Absent means
  the account default. The worker selects exactly that model in the provider UI; when the account does not
  offer it, `POST /fail {errorClass:"provider_refused"}` with a message the requester can act on. Never fall
  back to another model silently. Report the model that ran in `providerMeta.model`.
- `params.minLongEdge` (mockup and redesign, 512-8192 px) is the minimum longer side of every output image;
  2048 is the 2K tier. The worker picks the smallest download or upscale option that meets it. `complete`
  returns `422 validation_failed` with per-image `errors` when an image is smaller; the lease stays valid, so
  upload a larger file and complete again with a new `Idempotency-Key`.
- `gemini` with channel `browser` means the Google Flow web app (https://flow.google.com/). No Gemini API is
  used yet; `gemini` with channel `api` is reserved for later.
- The aspect ratio is `params.ratio`, as before; draft 2 adds no second ratio field.

## 4. Scheduling (server side, for information)

Order when an account claims:

1. Only jobs whose `type` and `provider` the account supports, and whose `requiredProviderSkills` are all
   reported installed on that account.
2. Priority tier: `interactive` > `normal` > `bulk`.
3. Round-robin across **stores**, then across **requesters** inside a store, so one large batch cannot
   starve everyone else.
4. Oldest first.

Claims use `FOR UPDATE SKIP LOCKED`, so two workers never get the same job. Quotas and budgets are
**not enforced**; the server only records usage per job (store, requester, store owner at that time) for later.

## 5. Error classes

| `errorClass` | Job | Account | Attempt counted |
|---|---|---|---|
| `account_rate_limited` | back to queue; may go to another account at once | `cooldown` until `retryAfterSeconds` (or server default) | no |
| `account_session_expired` | back to queue | `session_expired`; admins alerted; stays out of rotation until a human re-logs in and the worker reports `available` | no |
| `account_unavailable` | back to queue | short cooldown (browser crash, provider outage) | no |
| `provider_refused` | `failed`; `message` shown to the requester (content policy, unsupported input) | unchanged | yes |
| `input_invalid` | `failed`; `message` shown to the requester | unchanged | yes |
| `transient` | retried with backoff until `maxAttempts` | unchanged | yes |
| `cancelled` | `cancelled` (only after `cancelRequested`) | unchanged | no |

Loop guard: a job re-queued more than N times for account classes fails with "no healthy account".
Lease expiry without `complete`/`fail` counts as `transient`.

## 6. Idempotency, races and integrity

- `complete` and `fail` require `Idempotency-Key` (for example `<jobId>:<attempt>:complete`). Replays
  return the first result; reusing a key with a different body returns `422 idempotency_key_reused`.
- Every state change is a guarded update (`WHERE status = 'running' AND lease_token = $1`), so of two
  racing calls exactly one wins. **Cancel wins over complete**: once a cancel is recorded, `complete`
  returns `409 job_not_active` and uploaded files are garbage-collected.
- A reaper re-queues jobs whose lease expired without `complete` or `fail` (counted as `transient`).
- Input and upload URLs always point to an origin listed in `storageOrigins` from `/register`. Workers
  must refuse any other origin, so a tampered job cannot make the worker fetch internal addresses.
- Upload keys are bound to the lease. `complete` is rejected with `422 upload_missing` or
  `checksum_mismatch` unless every declared file exists with the declared sha256.
- `listing_content` locale always comes from `job.params.locale`, never from the payload.
- The server sanitizes and enforces length limits on text payloads; workers should return raw model
  output without truncating.

## 7. Skills

Three kinds share one manifest schema (`skill-manifest.schema.json`), and every published version is
immutable. Each job records the `versionId` it was built from, so any result can be traced to the exact
prompt.

| Kind | Example | Runs where | Webapp does |
|---|---|---|---|
| `prompt_template` | poster mockup prompt, listing content prompt | rendered by webapp, executed by worker | store, version, edit, review, bind to job/product/niche |
| `provider_skill` | ChatGPT skill `@create-wall-art-mockups` | inside the provider account | track which account has which version; route only to accounts that have it |
| `niche_agent` | POD design skill built from master data 2.0 | agent/worker | edit master data, run validator, store zip, publish |

A `prompt_template` may declare `requiresProviderSkills`; the scheduler then only offers the job to
accounts that report those skills installed (via `/register` or `/accounts/{id}/status`).

## 8. Questions for the workers/skills owner

1. Worker runtime: Python? One process per account, or one process driving several accounts?
2. Are the default timings (lease 180 s, heartbeat 45 s, claim wait 25 s) workable for the longest flow?
3. Which provider signals can the worker detect reliably, and how do they map to the error classes?
4. Can the worker detect installed provider skills automatically, or should it be declared by config?
5. Should text jobs (`listing_content`, `product_analysis`) run through browser accounts, or should they move
   to metered APIs later? The contract supports both via `channel`.
6. Is the redesign `intent` list right? What else is needed?
7. Is the `niche_agent` shape compatible with the POD skill builder output, and what validator version
   string should be recorded? The webapp will unpack skill zips with path checks (no `..`, no absolute
   paths, size and file-count limits); does the runtime need anything else from the archive?
8. Is there a need for partial results (for example the first 5 of 10 images) before `complete`?
9. Is 50 MB per output file and 20 files per job enough?
10. Anything the worker needs that is missing from `JobBase`?
11. `job.model` is an open id such as `nano-banana-pro` or `imagen-4` (Gemini through Google Flow) or
    `gpt-image` (ChatGPT). Which ids does each provider UI offer today, and how should the worker map an id
    to the label it clicks? Is `provider_refused` the right class when the account does not offer the model?
12. Do accounts of the same provider differ in the models they offer (for example by plan tier)? If yes,
    the next draft adds an optional `models` list to `AccountDeclaration` and the scheduler only offers a
    job with `model` to accounts that declare it. Draft 2 assumes every account of a provider offers the model.
13. `params.minLongEdge` defaults to 2048 in the webapp (the 2K tier used by the current sheet). Which
    download or upscale tiers does each provider offer (Google Flow: 1K, 2K, 4K), and is checking the
    declared `width`/`height` on `complete` enough, or should the server also decode the image header?
