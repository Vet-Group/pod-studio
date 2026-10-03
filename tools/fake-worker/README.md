# Fake worker

A one-shot Worker API v2 reference worker for local testing. It registers one provider account, claims at most one job, executes a scenario, and exits. It does not call a real AI provider. Runtime dependencies are native `fetch`, Node built-ins and `@pod-studio/contracts`; it never imports application, core or database code.

## Run

Install the workspace dependencies, start the webapp, and provision a worker token and its stable worker key through the admin flow. Queue a matching job for the account/provider you declare.

```sh
pnpm --filter @pod-studio/fake-worker start -- --help
```

Set **`WORKER_TOKEN` in your environment** to the admin-issued token. There is deliberately no token argument, config file or token fallback. Keep credentials out of shell history and logs. Then run:

```sh
pnpm --filter @pod-studio/fake-worker start -- \
  --base-url http://127.0.0.1:3000/api/worker/v2 \
  --worker-key your-admin-provisioned-key \
  --account-key fake-account \
  --scenario success
```

`--worker-key` must exactly match the identity provisioned by the admin. Registration reports the actual OS hostname; it does not invent a worker identity. The defaults are provider `gemini`, channel `browser`, account key `fake-account`, scenario `success`, and claim wait `0` seconds. Use `--provider` and `--channel` to match the queued job. All four job types are declared: `mockup`, `redesign`, `listing_content`, `product_analysis`.

An optional `--wait-seconds` (0–25) is also capped by `maxClaimWaitSeconds` from registration. A 204 claim logs that no job is available and exits successfully; there is no polling loop. Logs contain scenario/outcome/heartbeat count, never credentials, lease tokens, presigned URLs or remote problem details. A rejected CLI/API/storage operation exits nonzero. An intentionally failed/abandoned job or confirmed checksum rejection is a successful scenario execution and exits zero.

`--base-url` goes through the same `normalizeBaseUrl` guard that the `WorkerClient` constructor applies, so library callers get identical validation: it must be an absolute HTTP(S) URL with no embedded credentials, query string or fragment, and its path must not contain dot segments (`.`/`..`, including `%2e`), encoded separators (`%2f`, `%5c`), backslashes or empty segments, because URL parsing would otherwise silently resolve them to a different endpoint. Trailing slashes are removed. Error messages never echo the rejected value.

SIGINT or SIGTERM aborts the run: the long-poll claim, heartbeats and their retry backoff, and storage I/O stop immediately, complete/fail is skipped, and the process exits `130`. A claimed lease is left to the server reaper. A complete or fail that has already started is not interrupted, so its real outcome is still reported. A second signal exits at once.

## Scenarios

| Name | Behavior |
| --- | --- |
| `success` | Verify every input's exact byte count and SHA-256. Generate requested PNG images or schema-valid text JSON, then complete the job. |
| `slow` | Delay for three registered heartbeat intervals by default, heartbeat through the delay and storage work at the registered cadence, then finish normally. A cancellation request is acknowledged with `fail(errorClass: cancelled)`; lease loss discards the work. |
| `rate_limit` | Fail with `account_rate_limited` and a 60-second retry hint; let the server apply cooldown and retry policy. |
| `expired_session` | Fail with `account_session_expired`; let the server change account health and block claims. |
| `lease_timeout` | Return `abandoned` without heartbeats, storage I/O, complete or fail. The real server reaper must detect the expired lease and handle retry/failure; this worker never simulates that server result. |
| `checksum_mismatch` | Image jobs only: declare the real SHA-256 and upload correct PNG bytes, then corrupt **only the first image SHA-256 in completion**. Return `rejected` only if the server answers `checksum_mismatch`. Acceptance or a different rejection is an error. **Not applicable to text jobs**: throws an explicit unsupported error before doing work. |

For short tests, `--slow-duration-ms` overrides the synthetic delay and `--heartbeat-interval-ms` overrides cadence. In normal runs leave the cadence unset so registration remains authoritative. Heartbeats are serialized, counted when attempted, and stopped/drained before the final write; no timers or new heartbeats remain after the runner returns.

```sh
pnpm --filter @pod-studio/fake-worker start -- \
  --worker-key your-admin-provisioned-key --scenario slow \
  --slow-duration-ms 100 --heartbeat-interval-ms 20
```

## Outputs and storage boundary

Image output is a genuine non-interlaced 8-bit RGB PNG built from IHDR, deflated IDAT and IEND chunks with CRC-32 checksums, not a magic-byte placeholder. Each synthetic image has a deterministic solid color. Dimensions preserve the exact requested ratio using integer multiples and reach or slightly exceed `minLongEdge` (default 512). Image count follows job params. Upload declarations contain exact byte counts and hashes; PUT uses each target's required signed headers and completion references its `uploadKey`.

Memory stays bounded for large and numerous images. Rows stream through an asynchronous deflate in blocks of about 4 MiB, so the full raw frame (about 192 MiB at 8192×8192) is never allocated and the event loop stays free for heartbeats and cancellation. Compressed images are declared and uploaded in batches: a batch is flushed once it reaches `maxStagedBytes` (default 64 MiB), so at most that budget plus one image is held at a time. The Worker API accepts repeated `/uploads` calls up to 20 targets per job.

Measure peak RSS per case, each in a fresh process with in-process API and storage stubs:

```sh
pnpm --filter @pod-studio/fake-worker measure:rss
pnpm --filter @pod-studio/fake-worker measure:rss -- --counts 20 --edges 8192 --max-staged-mib 1
```

On Windows with Node 24, 20 images at 8192×8192 peaked at 32.7 MiB above the process baseline, down from 391.5 MiB with a full raw frame and synchronous deflate per image.

The two text outputs satisfy the checked-in `ListingContentPayload` and `ProductAnalysisPayload` JSON Schemas. They are explicitly synthetic English samples, not real model output or a localization implementation. Listing content avoids `takenKeywords`. Locale metadata echoes job params for diagnostics only; the server takes the authoritative locale from the job, never from output.

Every input and upload URL must use HTTP(S), have no embedded credentials, and exactly match an origin in registration's `storageOrigins` (scheme, host and port). All URLs in a batch are checked before requests begin. Downloads verify exact size and SHA-256 using bounded streaming reads. Storage requests have a 30-second timeout, reject redirects, omit browser credentials, and never use the Worker's bearer token. Upload headers containing Authorization, Proxy-Authorization or Cookie are refused. Signed URL query parameters are retained for the storage request, but are never logged.

## Tests and runner API

```sh
pnpm --filter @pod-studio/fake-worker test -- test/unit.test.ts
pnpm --filter @pod-studio/fake-worker typecheck
```

Focused unit tests mock only the public client methods and native storage transport. They decode/verify PNG chunks, CRCs and pixels; check request/payload schemas, declared/uploaded hashes, quantity and ratio; exercise every scenario, heartbeat cancellation/lease loss and timer cleanup; and check storage origin, credentials, redirect and authorization protections. Parent integration tests exercise the real API, account transitions, completion rejection and server lease reaper separately.

`src/scenarios.ts` exports `scenarios`, `Scenario` and:

```ts
runScenario(client, job, registration, scenario, {
  slowDurationMs?: number,
  heartbeatIntervalMs?: number,
  maxStagedBytes?: number,   // default 64 MiB
  signal?: AbortSignal,      // local shutdown; resolves 'abandoned' without complete/fail
}): Promise<{
  outcome: 'completed' | 'failed' | 'abandoned' | 'rejected';
  heartbeatCount: number;
}>
```

`failed` describes a successfully reported failure, including acknowledged cancellation; server retry/account effects remain server-owned. Unexpected input/storage/API failures are thrown instead of fabricated as job success or checksum rejection.
