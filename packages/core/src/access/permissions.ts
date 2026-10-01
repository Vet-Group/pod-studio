/** Store roles and permissions from ADR 0002. Memberships live in `store_members`. */

export const STORE_ROLES = ['owner', 'co_leader', 'seller_support', 'seller', 'designer', 'viewer'] as const;
export type StoreRole = (typeof STORE_ROLES)[number];

export const STORE_PERMISSIONS = [
  'store.view',
  'analysis.run',
  'product.edit',
  'content.generate',
  'product.push',
  'product.publish',
  'store.members',
  'store.settings',
  'design.upload',
  'design.share',
] as const;
export type StorePermission = (typeof STORE_PERMISSIONS)[number];

/**
 * Default permissions per role (the ✓ cells in ADR 0002). The role only fills the list; the owner may
 * then toggle individual permissions, bounded by the grant rules in members.ts.
 */
export const ROLE_PRESETS: Record<StoreRole, readonly StorePermission[]> = {
  owner: STORE_PERMISSIONS,
  co_leader: ['store.view', 'analysis.run', 'product.edit', 'content.generate', 'product.push', 'store.members', 'design.upload', 'design.share'],
  seller_support: ['store.view', 'analysis.run', 'product.edit', 'content.generate'],
  seller: ['store.view', 'analysis.run', 'product.edit', 'content.generate'],
  designer: ['store.view', 'design.upload'],
  viewer: ['store.view'],
};

/**
 * What a global admin may do in any store, with or without a membership: see it, work on listings
 * and manage members. Admin is never implicitly allowed to push, publish or read Shopify credentials;
 * those must be granted through a membership like for anyone else (ADR 0002).
 */
export const ADMIN_STORE_PERMISSIONS: readonly StorePermission[] = [
  'store.view',
  'analysis.run',
  'product.edit',
  'content.generate',
  'store.members',
];

/**
 * What an admin may grant in a store from its admin role alone: everyday access only. Push, publish,
 * store settings and member management stay with the owner's chain of trust.
 */
export const ADMIN_GRANTABLE: readonly StorePermission[] = ['store.view', 'analysis.run', 'product.edit', 'content.generate'];

/** Human labels, shared by the UI and audit summaries. */
export const STORE_ROLE_LABELS: Record<StoreRole, string> = {
  owner: 'Store owner',
  co_leader: 'Co-leader',
  seller_support: 'Sales support',
  seller: 'Seller',
  designer: 'Designer',
  viewer: 'Viewer',
};

export const STORE_PERMISSION_LABELS: Record<StorePermission, string> = {
  'store.view': 'View store',
  'analysis.run': 'Run analysis',
  'product.edit': 'Edit products',
  'content.generate': 'Generate content',
  'product.push': 'Draft push',
  'product.publish': 'Shopify publish',
  'store.members': 'Manage members',
  'store.settings': 'Store settings',
  'design.upload': 'Upload designs',
  'design.share': 'Share designs',
};

export function isStoreRole(value: unknown): value is StoreRole {
  return typeof value === 'string' && (STORE_ROLES as readonly string[]).includes(value);
}

export function isStorePermission(value: unknown): value is StorePermission {
  return typeof value === 'string' && (STORE_PERMISSIONS as readonly string[]).includes(value);
}

/** Orders a permission list the way STORE_PERMISSIONS does and drops duplicates. */
export function sortPermissions(permissions: Iterable<StorePermission>): StorePermission[] {
  const set = new Set(permissions);
  return STORE_PERMISSIONS.filter((p) => set.has(p));
}
