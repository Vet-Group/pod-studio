# Shopify connections

Store members can view only connection status and fixed credential masks. Saving, testing,
rotating and removing credentials require `store.settings`; a global admin has no bypass.
Client secrets and access tokens never leave core after encryption/decryption. Each successful
mutation and each completed connection test writes a secret-free audit event.

## Encryption configuration and rotation

- `SHOPIFY_ENCRYPTION_KEYS`: comma-separated `v1:<base64 key>,v2:<base64 key>` pairs. Each key
  must decode to exactly 32 random bytes. Generate keys outside source control using
  `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`.
- `SHOPIFY_ENCRYPTION_ACTIVE_VERSION`: version used for new writes, default `v1`.
- Missing/invalid keys fail closed. Back up keys separately from the database.

Credentials use AES-256-GCM with a random 12-byte nonce, a 16-byte authentication tag, and
additional authenticated data binding the key version, store ID and credential field. The
stored envelope contains `version.nonce.ciphertext.tag` in base64url. Swapping fields/stores or
tampering fails authentication. Neither key material nor plaintext appears in errors or audit data.

To rotate, add the new key while retaining old keys, switch the active version and restart the
web process. For each store, use **Rotate encryption key** (or the corresponding core function).
Only retire an old key after all stored envelopes have been re-encrypted and backups depending
on it have expired. Rotation preserves the previous connection-test status; replacing credentials
resets status to untested. Losing an old key makes its remaining envelopes unreadable.

## Shopify catalog import and variant resync (P2-10)

Import and resync are **local catalog writes**, not Shopify push/publish operations. Both require
`product.edit` through `can()` **and that grant on an explicit store membership**, including for global admins.
Connection configuration still requires `store.settings`. The catalog hides write controls from
read-only users and disables import with an explanation when the store has no connection. A configured
connection is sufficient; an unsuccessful API request fails the run without exposing credentials.

`startShopifyImport(db, principal, storeId, productTypeId)` validates the store/type, serializes starts
on the store row, rejects another queued/running Shopify run for the entire store (regardless of product
type), and audits the
request. `runShopifyImport(db, runId, deps?)` uses the encrypted connection and throttled client,
queries `product_type:"<name>"` with cursor pagination, and skips previously tracked GIDs. The existing
P2-03 model's `product_types.name` is the Shopify product-type filter (there is no separate key yet).
It copies listing metadata, maps ACTIVE to active and DRAFT/ARCHIVED to local draft, generates only
current price-table variants in sort_order, starts SKU at NULL/inventory at 100, and imports no images.
Tracking rows start pushed with a NULL checksum so the next push takes the update path. A unique
(store_id, shopify_gid) index plus ON CONFLICT prevents duplicate imports. Each product, tracking row,
variants, counters and edge cursor commit together; malformed products roll back to a savepoint and
append a secret-free error without aborting later products. `total_rows` counts processed edges, not an
estimated upstream count; imported + skipped + per-product errors equals that count on completed runs.

The web action schedules execution with Next 16 `after()` so the response is sent first. The catalog
polls an authenticated, private/no-store endpoint while active and shows the latest ten runs, processed
counts and expandable error logs. The compact product list returns at most the latest 50 products with
an accurate total, avoiding an unbounded payload on each poll. The **Catalog products** section includes
all local products (not just Shopify-tracked products); resync is a local price-table operation and
works for manual/CSV/Sheet-created products too. Only the run feed and busy state are Shopify-specific.
The web process must remain alive and the host must allow enough
post-response execution time for the run. This is not a durable queue; the P1-06 jobs integration will
supply a worker wrapper and stale-run scheduler later. No new environment variables are required.

### Safe recovery

A running run's `started_at` is a **lease heartbeat**, refreshed after each processed product. A run
with a heartbeat older than **15 minutes** (`IMPORT_STALE_MS`) can be resumed by calling
`runShopifyImport(db, runId)` again from a trusted worker using the same environment/keyring. Fresh
running runs are no-ops, as are done/failed runs. Claiming locks the run row; every commit checks the
opaque `attempt_token`, regenerated on every claim/takeover, so an older worker cannot commit catalog,
cursor, counters, completion or failure after takeover. The heartbeat only controls staleness, never
ownership. Resume uses the persisted edge
cursor and counters; already committed products cannot be duplicated. Permissions are rechecked for
the requesting user before execution and under the same store lock as membership/price-table changes
before each product. Revoked access stops the run. Network/connection failures mark failed with a safe
log; claim/decryption/setup failures are also persisted as failed without rejecting the background
promise. Failure persistence is best-effort during a database outage and logs only a fixed safe line.
Starting a new run skips already imported GIDs. Queued runs can be executed directly. Do not edit
cursors or counters manually. Monitor queued/running runs if the web process is restarted mid-import.
Per-product errors name the numeric Shopify product ID shown in Shopify admin URLs, never the internal
GID or upstream error text.

`resyncVariants` preserves identities by canonical sorted option-name/value keys, never variant index.
It refreshes price/excluded markets/positions from current price rows, adds new combinations, deletes
removed combinations, and keeps the shared design-filename SKU (NULL remains NULL). `price_row_id` uses
ON DELETE SET NULL because saving the price table replaces rows; option identity survives those writes.
Resync and import lifecycle events are audited without tokens, HTML, titles or upstream error bodies.

## GraphQL transport and tests

Production requests use `https://<store>.myshopify.com/admin/api/<version>/graphql.json`.
The client never follows redirects, uses a 10-second timeout per attempt, and makes at most
three retries by default (configurable from zero to five). HTTP 429 and GraphQL `THROTTLED`
respect `Retry-After` and `extensions.cost.throttleStatus`, with exponential backoff. Cost
metadata also paces the next successful request. A required wait above ten seconds fails
closed instead of ignoring Shopify's requested delay. Upstream errors/bodies are never echoed.

`SHOPIFY_ENDPOINT_OVERRIDE` is optional and honored only in test/development, for HTTP URLs
on literal loopback addresses. Production always ignores it, including explicit caller overrides.
The deterministic fixture at `tests/support/shopify-stub.ts` binds only to `127.0.0.1`, does not
retain credentials or request payloads, and never calls Shopify. Playwright starts this stub on
`WEB_PORT + 10000` and uses a newly generated throwaway encryption key each run. E2E tests
check encrypted persistence, safe audit records, masked HTML, owner operations and read-only
member access against an isolated test database.
