# Store-scoped object storage and design library

P1-05 exposes a backend-first API; the full Studio screen is P1-09.

## Storage configuration

Set `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `S3_BUCKET`.
The bucket must exist and be private (no anonymous GET/list access). The app never returns S3
credentials. All clients use `forcePathStyle: true`, compatible with MinIO and Cloudflare R2.
Optionally set `S3_PUBLIC_ENDPOINT` for browser-facing signing when the server endpoint is internal
(e.g. `http://minio:9000`), while a reverse proxy serves `https://app.example/<bucket>/<key>`.
Only the signing client uses the public endpoint; reads, writes and deletes use the internal client.
Do not rewrite a signed host/path/query in the reverse proxy. Leave the public endpoint unset in
local development, or when browsers and the server reach the same endpoint. Cross-origin deployments
must configure bucket CORS for the app origin, PUT/GET, and the Content-Type request header.

## Access model

- `store.view`: list a store library, read source assets or explicitly shared designs.
- `design.upload`: request/finalize uploads and create designs. Presets: owner, co-leader, designer.
- `design.share`: share a source-owned design. Presets: owner, co-leader. The actor must also have
  `design.upload` in the destination. Sharing and its audit row commit in one database transaction.
- Global admins have no implicit library write permissions. Migration backfills only existing owner memberships with the new library permissions and a
  system audit row, so owners can grant them down the chain of trust. Other existing membership
  arrays are preserved; owners can explicitly opt them into the new permissions.
- Receiving stores cannot re-share designs on behalf of their source. Raw asset reads always check
  the source store; shared reads use the design grant and the destination's current store permission.
- Signed reads expire after 60 seconds by default (configured range 1-900 seconds). Revocation blocks
  new URLs immediately; already issued bearer URLs remain usable only until their expiry.

## Upload protocol

`POST /api/designs` requires an active session, JSON and the configured app origin
(`BETTER_AUTH_URL`). Responses are `{ ok: true, data }` or `{ ok: false, code, error }`;
all responses are private/no-store. Operations:

1. `request-upload`: `{ storeId, sha256, sizeBytes, contentType }`, returns
   `{ uploadId, url, headers, expiresAt }`. SHA-256 is lowercase hex. Images are PNG/JPEG/WebP/GIF,
   1 byte to 20 MiB. No SVG/HTML is accepted. PUT URL expiry defaults to 300 seconds.
2. PUT the bytes directly to `url` with the exact returned headers, not through the application server.
3. `finalize-upload`: `{ storeId, uploadId }`. Only the requester with current upload permission can
   finalize. The server reads a bounded snapshot, verifies size, type and SHA-256, and deletes rejected
   staging objects. SHA mismatch returns `CHECKSUM_MISMATCH`. Missing/expired/rejected uploads are
   explicit errors. Retrying a successfully finalized upload returns the same asset.
4. `create`: `{ storeId, assetId, name }`, creates the store-owned design.
5. `share`: `{ storeId, designId, targetStoreId }`, creates one explicit grant and one audit row;
   duplicate/concurrent sharing is idempotent.

`GET /api/designs?storeId=...` lists metadata. Add `assetId` or `designId` (not both) to obtain
`{ url, expiresAt }` after the scope check. Upload, rejection, finalization, design creation, sharing
and read-capability issuance are audited using IDs only; never persist signed URLs or credentials.

`features/designs/upload-queue.ts` hashes each browser File, uploads directly, finalizes and creates
a design sequentially. One failed file does not finalize and does not block later queue items.

## Integrity and lifecycle

Staging keys are `stores/<storeId>/uploads/<uploadId>`; verified keys are
`stores/<storeId>/assets/<assetId>`, compatible with contract `AssetRef.storage_key`.
A unique database index deduplicates `(store_id, sha256)`, including racing finalizations. Every
candidate object has a unique key; losing candidates are deleted. Finalization writes the exact
verified snapshot to a new key rather than CopyObject: an unexpired PUT must never mutate a verified
asset or race a copy. Rollbacks compensate candidate writes; cleanup failures are surfaced.

S3 and Postgres cannot share a transaction. A process crash can leave an orphan candidate; an
abandoned/replayed staging PUT can leave an upload object. Configure a bucket lifecycle rule to
expire the `stores/*/uploads/` staging segment (use per-store prefixes or tag-based rules on providers
without wildcard lifecycle prefixes), and reconcile orphan assets operationally. This task does not
introduce a background garbage collector. Never apply lifecycle expiration to verified asset keys.

Tests use real per-test MinIO buckets and isolated Postgres databases. Playwright gives its server
and workers one per-run bucket and removes it on teardown. Production URLs are blocked by test guards.
