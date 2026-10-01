/** Store roles and permissions from ADR 0002. Store memberships themselves arrive with P1-04. */

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
] as const;
export type StorePermission = (typeof STORE_PERMISSIONS)[number];

/** Default permissions per role (the ✓ cells in ADR 0002); owners toggle the rest individually. */
export const ROLE_PRESETS: Record<StoreRole, readonly StorePermission[]> = {
  owner: STORE_PERMISSIONS,
  co_leader: ['store.view', 'analysis.run', 'product.edit', 'content.generate', 'product.push', 'store.members'],
  seller_support: ['store.view', 'analysis.run', 'product.edit', 'content.generate'],
  seller: ['store.view', 'analysis.run', 'product.edit', 'content.generate'],
  designer: ['store.view'],
  viewer: ['store.view'],
};

export function isStoreRole(value: unknown): value is StoreRole {
  return typeof value === 'string' && (STORE_ROLES as readonly string[]).includes(value);
}

export function isStorePermission(value: unknown): value is StorePermission {
  return typeof value === 'string' && (STORE_PERMISSIONS as readonly string[]).includes(value);
}
