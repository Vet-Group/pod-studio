import type { StorePermission, StoreRole } from '@pod-studio/core';

/**
 * Plain data the server pages hand to the client components. Client code must not import runtime
 * values from @pod-studio/core (that would bundle the database layer), so labels and presets travel
 * as props.
 */
export interface RoleOption {
  value: StoreRole;
  label: string;
  /** The role's preset permissions (ROLE_PRESETS). */
  permissions: StorePermission[];
}

export interface PermissionOption {
  value: StorePermission;
  label: string;
}

export interface AccountChoice {
  userId: string;
  name: string;
  email: string;
}

export interface InviteView {
  id: string;
  email: string;
  roleLabel: string;
  /** YYYY-MM-DD, formatted on the server so the client renders the same text. */
  expires: string;
}
