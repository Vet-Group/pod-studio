# ADR 0002: Accounts, invites and store-scoped permissions

Status: proposed (2026-09-30)

## Context

- No SSO. An admin creates accounts, or sends an invite link where the person fills in their own name and
  password (like joining a workspace).
- Many store owners ("leaders") use the same webapp. One leader can own several Shopify stores.
- Only the leader of a store, or people that leader delegates to (for example a seller support or a
  co-leader), may push products to that store's Shopify.
- No quota or budget enforcement for now. Usage is recorded so it can later be split by store or leader.

## Decision

### Global level

| Global role | Meaning |
|---|---|
| `admin` | Runs the system: users, invites, AI accounts, workers, skill publishing, all audit logs. Admin is **not** automatically allowed to push to a store; it must be granted like anyone else, which keeps every Shopify write attributable to someone the store owner trusts. Admin can transfer store ownership. |
| `member` | Everyone else. |

Global permissions (granted per user by an admin): `store.create` (typical for leaders),
`skill.author`, `skill.publish`, `design.upload`.

### Store level

A user's access to a store is one row in `store_members (store_id, user_id, role, permissions[])`.
The role is a **preset** that fills the permission list; the owner can then toggle individual permissions.

| Permission | owner | co_leader | seller_support | seller | designer | viewer |
|---|---|---|---|---|---|---|
| `store.view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `analysis.run` | ✓ | ✓ | ✓ | ✓ | | |
| `product.edit` (create, edit listing) | ✓ | ✓ | ✓ | ✓ | | |
| `content.generate` | ✓ | ✓ | ✓ | ✓ | | |
| `product.push` (write to Shopify, as draft) | ✓ | ✓ | toggle | | | |
| `product.publish` (status active, sales channels) | ✓ | toggle | toggle | | | |
| `store.members` (invite, change roles) | ✓ | ✓ | | | | |
| `store.settings` (Shopify credentials, product types, pricing) | ✓ | toggle | | | | |

Rules:

1. Each store has exactly one `owner`. Only the owner or an admin can transfer ownership.
2. Nobody can grant a permission they do not hold. `product.publish` can be granted only by the owner.
3. The last owner cannot be removed or demoted.
4. Anyone with `product.edit` but without `product.push` gets **"Request push"** instead of "Push". The
   request lands in the store's push queue, visible to members holding `product.push`.
5. Checks live in `packages/core` (`can(principal, permission, { storeId })`). The UI only mirrors them
   (hide or disable with an explanation), never replaces them.

### Designs

**Decided (product owner, 2026-09-30):** designs are **store-scoped**. A design belongs to the store
it was uploaded for, and sharing it with other stores is an explicit action. Mockup and redesign results
follow the visibility of their design. The **skill library is company-wide**: holders of `skill.edit`
draft niche master data and skill versions, only holders of `skill.publish` publish (ADR 0003).
Products, listings, pricing, credentials and pushes are always store-scoped.

P1-05 makes library permissions explicit in store memberships: `design.upload` defaults to owner,
co-leader and designer; `design.share` defaults to owner and co-leader. Reading uses `store.view`.
Neither library write permission is an implicit global-admin permission. Sharing requires
`design.share` in the source and `design.upload` in the destination and writes an atomic audit row.
A recipient can read the shared design but cannot re-share it on behalf of the source store.
These store grants are the implementation of design upload access; no global upload grant may
bypass the destination store check. The upgrade grants these permissions to existing owners only,
with system audit records; other memberships retain their exact grants until an owner changes them.

### Invites and account creation

- Invite = `invites (email, token_hash, global_role, store_id?, store_role?, permissions[], invited_by,
  expires_at, accepted_at, revoked_at)`. Token is random, shown once as a link, stored as a hash,
  single-use, default expiry 7 days.
- Who can invite: admins (any scope); store members with `store.members` (only into their own store,
  never with more permissions than they hold).
- Accepting: if the email has no account, the invitee sets name and password; if it already has one,
  they sign in and the store membership is added.
- Direct creation: an admin creates the account with a temporary password; the user must change it at
  first sign-in.
- Password reset: admin-triggered reset link. Email delivery is optional; every link can also be copied
  and sent through chat.
- Public sign-up is disabled.

### Usage recording (not enforcement)

Each finished AI job writes `usage_events (job_id, job_type, provider, account_id, requester_id,
store_id?, units, created_at)`. No limits are applied. A later plan can build per-store or per-leader
quotas on this data.

## Consequences

- Push rights follow the store owner, not the company hierarchy, which matches how stores are run.
- Admins can see and fix everything except pushing on a store's behalf, unless the owner grants it.
- Design library scope is closed: store-scoped designs, company-wide skills (see "Designs", ADR 0003).
