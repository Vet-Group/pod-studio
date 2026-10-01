import type { Principal } from '@pod-studio/core';

/** The access-control principal for a signed-in user. Anything but `admin` is a plain member. */
export function principalOf(user: { id: string; role?: string | null }): Principal {
  return { userId: user.id, role: user.role === 'admin' ? 'admin' : 'member' };
}
