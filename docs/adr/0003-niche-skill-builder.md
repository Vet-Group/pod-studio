# ADR 0003: Niche master data editor, skill build and subscription account secrets

Status: accepted (2026-09-30)

## Context

- A niche skill (for example "teacher gifts") is generated from one JSON master data file by the
  `pod-design-skill-builder` generator (`scripts/create_pod_design_skill.py`, `SCHEMA_VERSION = "2.0"`).
  Today someone edits that JSON by hand, runs the script, reads English error lines and fixes the file.
- ADR 0002 left the design library scope open. The product owner closed it on 2026-09-30: designs stay
  store-scoped; the **skill library is company-wide**. Anyone holding `skill.edit` drafts, only holders of
  `skill.publish` publish.
- Workers drive subscription accounts (ChatGPT, Claude, Grok, Gemini and similar services) through a
  browser. Sessions expire or get logged out, and today someone logs in again by hand. The account
  passwords and TOTP seeds must not live in Postgres, job payloads or logs.
- Scope stays split: the webapp (this repo) owns the editor, storage, jobs and permissions; ngatruong123
  owns worker and skills runtime code. The interface is `packages/contracts` plus presigned URLs.

## Decision

### 1. Master data is the source; a skill version is a build output

- Table `niche_master_data` (company-wide, versioned, `schema_version = "2.0"`). Each saved draft is a
  row revision; publishing is not done here.
- A build job runs the generator as a subprocess with a timeout, then stores the result as an immutable
  `skill_version` in `draft` state (P3-01 lifecycle). Every skill version records the master data revision
  and the market-fit score it was built from.
- The generator is the final judge. The editor mirrors its rules so people see errors early, and a
  shared fixture (`teacher-example-data.json` plus broken variants) must give the same verdict in the
  TypeScript rules and in the Python script.

### 2. The 17 sections and their minimum counts (from the generator, not guessed)

| Step | Section | Rule |
|---|---|---|
| 1 | `niche`, `niche_display`, `locale`, `schema_version` | required, `schema_version` must be `2.0` |
| 1 | `niche_profile` | 6 required fields |
| 1 | `data_provenance` | `status` in `curated-draft`, `researched`, `validated`; at least 1 source |
| 1 | `personas` | at least 8 |
| 1 | `buyer_recipient_pairs` | at least 5 |
| 2 | `occasions` | at least 8 |
| 2 | `emotions` | at least 6 |
| 2 | `buyer_language` | at least 6 |
| 3 | `visual_vocabulary` | motifs at least 10, palettes at least 3, typography at least 3, compositions at least 4 |
| 3 | `product_fit` | at least 5 |
| 3 | `personalization_fields` | at least 4 |
| 4 | `hook_patterns` | at least 8 |
| 4 | `sample_briefs` | at least 6 |
| 4 | `market_fit_calibration` | thresholds fixed at 25, 21, 16, 15 |
| 5 | `style_variants` | **exactly 4** |
| 5 | `ip_safety` | avoid list at least 5, safe substitutions at least 3, human review triggers at least 3 |
| 5 | `qa_rules` | one object: background `#00FF00`, ratio `3:4`, `max_colors` integer 1 to 12, palettes must not contain `#00FF00` |

Only `style_variants` is an exact count; every other list is a minimum. Error text reuses the generator
format (`occasions: requires at least 8 records; found 6`) so the UI, logs and the script read the same.

### 3. Market fit scoring

Six criteria, each 1 to 5, total out of 30: visual clarity at a glance, gift fitness, emotional pull,
differentiation, series or bundle potential, IP and trademark safety.

| Total | Verdict |
|---|---|
| 25 to 30 | Go |
| 21 to 24 | Refine |
| 16 to 20 | Rework |
| 15 or less | Replace |

An IP score below 4 blocks the idea whatever the total. The thresholds are not editable per niche; the
generator rejects any other value.

### 4. Editor UX (wireframe screen 7, "Dữ liệu ngách")

- Five steps: buyers, occasions and emotions, visuals and products, hooks, briefs and scoring, style,
  IP and QA. Each step shows its own error count.
- Every list field shows `current/minimum`, a progress bar and sample values. The exact-4 field disables
  "add" at 4 and says to edit or replace instead.
- A validator panel lists every error; "Sửa" jumps to the step and focuses the field.
- "Build skill version" stays disabled while any error remains. A build never publishes.
- A sticky action bar keeps previous, next and build reachable at 1024, 760 and 390 px.

### 5. Subscription account secrets: OpenBao

Use OpenBao (MPL-2.0 fork of HashiCorp Vault, <https://github.com/openbao/openbao>) as the only store for
account passwords, recovery codes and TOTP seeds.

- Storage: KV v2 at `pod/accounts/<provider>/<account_id>` (versioned, so a wrong password can be rolled
  back). TOTP seeds go to the `totp` secrets engine, which returns codes and never gives the seed back.
- Worker access: each worker host authenticates with AppRole (role ID baked into deployment, secret ID
  short-lived and delivered at start). Policy allows read on `pod/accounts/*` and `totp/code/*` only.
- Delivery: the job carries `credential_ref` (path plus version), never the secret. The worker requests
  the secret with response wrapping; the wrap token is single use with a short TTL, so a leaked token
  from a log is useless after first use.
- Relogin flow: when a worker detects `session_expired` it fetches the credential, logs in, stores the new
  browser session on its own disk only, and reports `available`. If the site asks for captcha, device
  approval or email confirmation, the account moves to a waiting-for-human state and admins are alerted;
  the worker never loops.
- Webapp: stores only metadata (provider, label, state, last relogin result, credential version). Admins
  write or rotate a secret through a form that posts straight to OpenBao; the value never touches Postgres.
- Audit: OpenBao audit device on, log shipped with values HMAC'd.

## Consequences

- One source of truth for niche data; skill versions are reproducible from it.
- The editor must track the generator. A generator update that changes a rule fails the shared fixture
  test before it reaches users.
- Licensing of the vendored generator is still unconfirmed (no LICENSE file in the shared copy). Until
  it is cleared, the build job calls the script from the skill pack path and does not copy its code.
- OpenBao adds one more service to run: unseal keys, backups and upgrades. The first deployment uses a
  single node with integrated storage; high availability waits until measured need.
- ADR 0002 "Designs" section is updated to record the closed decision.

## Rejected alternatives

- **Edit JSON by hand plus CLI**: keeps today's slow loop and English-only errors.
- **Secrets in Postgres encrypted with an app key**: the app key sits beside the data and every webapp
  bug becomes a secret leak. Shopify store tokens stay encrypted in Postgres (P2-05) because the webapp
  itself must call Shopify; subscription accounts are only used by workers.
- **HashiCorp Vault**: same model, but the BSL licence restricts use; OpenBao keeps the API under MPL-2.0.
- **Browser profile sync only (no password store)**: fails as soon as a provider forces a full relogin.
