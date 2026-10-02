# Worker API v2

The HTTP prefix is `/api/worker/v2`. OpenAPI and examples in `packages/contracts` are the source of truth. Version `2.0.0-draft.2` remains a draft; this delivery does not grant the external worker-team approval.

## Authentication and credentials

Send `X-Contract-Version: 2` and `Authorization: Bearer <worker-token>` on every request. Missing or unsupported versions return `426 contract_version_unsupported`; missing, unknown, disabled or revoked credentials return `401 unauthorized`. Worker routes bypass the Studio cookie-session proxy only within the exact v2 namespace, then authenticate independently. Tokens never authorize user-facing Studio APIs.

An administrator calls the core `provisionWorker(db, principal, { workerKey, host, version })` action. The return contains the opaque credential once; save it securely on the worker. Only a SHA-256 digest is persisted. Provisioning the same stable key rotates the credential and invalidates the old token. `revokeWorker(db, principal, workerId)` disables it immediately. Non-admin calls fail. Provision, register and revoke write secret-free audit rows; raw tokens are never written to audit or job results. No provisioning UI is included.

`POST /register` reports the stable key and provider-account capabilities without browser cookies, provider passwords or account email. Accounts omitted from subsequent registration are offline. Account status is scoped to the authenticated worker; explicit `available` reports resume a human-restored session. Installed skills are retained when a status report omits them.

## Claim and leases

`POST /claim` accepts `workerId`, `accountId`, optional narrowed `jobTypes`, and `waitSeconds` from 0 to 25. Omitted `waitSeconds` defaults to 0, returning immediate `204` when no eligible job exists, as specified by OpenAPI. Set 25 explicitly for long polling. The implementation reuses P1-06 fair scheduling and account concurrency guards; it does not maintain another dispatch queue.

Poll waits hold no database transaction or row lock. Client abort releases timers/listeners, no further claim is attempted, and at most four polls are active per worker per server process. Claim attempts back off for 1-1.25 seconds with jitter; credentials are rechecked at most every five seconds during polling. `POST /jobs/{jobId}/heartbeat` extends the current lease for 180 seconds; report every 45 seconds. Stale/reassigned/expired leases return `409 lease_lost` and work must be discarded. A cancellation acknowledgement uses `fail` with `errorClass: cancelled`.

## Uploads and completion

1. Receive server-signed immutable input asset URLs with the claim.
2. Call `POST /jobs/{jobId}/uploads` with the lease and each output's declared content type, bytes and lowercase SHA-256.
3. PUT the exact bytes to each target URL using its returned headers before expiry.
4. Call `complete` with the returned upload keys, checksums and image metadata, or with a text payload for a text job.

The claimed job may carry `model` (the provider model the requester chose; absent means the account default) and image jobs may carry `params.minLongEdge` (pixels, 512-8192; 2048 is the 2K tier). The worker selects exactly that model or fails with `provider_refused`, and reports the model that ran in `providerMeta.model`. `complete` returns `422 validation_failed` with per-image `errors` when any declared image has `max(width, height) < minLongEdge`; nothing is recorded for that `Idempotency-Key` and the lease stays valid, so the worker can upload a larger download and complete again with a new key.

Declarations are bound to worker, job and lease. Completion checks the actual object checksum, content type and byte count and copies verified bytes to a private immutable asset key. The guarded completion transaction persists real result records and assets. Cancel and complete cannot both win. Private losing candidates and staging objects are recorded in durable `worker_cleanup`; `runCleanup(storage, db, limit)` performs bounded deletion with backoff, retaining staging tasks until one second after PUT URLs expire to prevent a late PUT recreating an orphan. Hosts must invoke this core cleanup sweep periodically; a scheduler deployment is outside P1-07.

## Idempotency and errors

`complete` and `fail` require an 8-128 character `Idempotency-Key`. The unique scope is worker + job + key; operation and canonical JSON body contribute to the hash. Same key and same logical body returns the first status/body, including concurrent requests and replays after staging cleanup. Changed bodies or using a completion key for failure return `422 idempotency_key_reused`. Only one transition and corresponding audit row commit.

All failures use `application/problem+json` and the shared RFC 9457 schema. Common mappings:

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | validation_failed | Malformed JSON, schema, parameters or idempotency header |
| 401 | unauthorized | Missing, unknown or revoked worker token |
| 404 | not_found | Unknown or worker-invisible resource |
| 409 | lease_lost | Expired, superseded or cancelled lease |
| 409 | account_not_claimable | Account is offline, disabled, expired or cooling down |
| 422 | upload_missing | Missing/unknown upload key or missing uploaded object |
| 422 | checksum_mismatch | Actual bytes, content type or checksum disagree |
| 422 | idempotency_key_reused | Reused key with different operation/body |
| 426 | contract_version_unsupported | Header is absent or not exactly 2 |
| 429 | rate_limited | Per-process worker request/poll bound exceeded |

Failure transitions reuse the P1-06 `ERROR_CLASSES` policy. Account errors requeue without counting an attempt; refusals and invalid input are terminal; transient errors use bounded retry/backoff. Only requester-safe failure messages are exposed; diagnostics must not include credentials or secrets.

## Limits and skills

JSON bodies are streamed and capped at 1 MiB even without Content-Length. Output declarations permit up to 20 PNG/JPEG/WebP files at 50 MiB each. Each server process enforces 120 requests/minute per authenticated worker and four active claims; multi-process production deployments should add a shared edge limiter. Responses are no-store. Skill-version GET serves published/deprecated immutable manifests and optional short-lived artifact URLs, never draft manifests.

Migration `0010_worker_api_v2` extends worker credentials, durable replay/upload/cleanup/result records and generation snapshots, leaving migrations 0000-0009 unchanged. `pnpm test` includes the HTTP contract and 100-pair real Postgres/MinIO cancellation tests; `npm ci && npm run check` independently validates every contract example and generated types in CI.

## Contract deviations or questions

- The initial task brief requested a 25-second default, but the authoritative draft specifies 0. Implementation follows the contract; pass 25 explicitly for long polling.
- README section 8 contains thirteen unresolved questions: the original ten worker-runtime/timing/provider/skill/text/redesign/archive/partial-output/size/job-envelope questions, plus three added in `2.0.0-draft.2` about model ids, per-account model availability and download tiers. Written confirmation by `ngatruong123` remains outstanding. `2.0.0-draft.2` adds optional `job.model` and `params.minLongEdge`; it is still a draft and is not marked approved.
