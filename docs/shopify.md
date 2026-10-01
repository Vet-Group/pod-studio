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
