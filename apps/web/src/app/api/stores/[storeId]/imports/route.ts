import { isAuthError, listShopifyImports } from '@pod-studio/core';
import { getDatabase } from '@/lib/auth';
import { principalOf } from '@/lib/principal';
import { getCurrentSession } from '@/lib/session';

export async function GET(_request: Request, { params }: { params: Promise<{ storeId: string }> }) {
  const session = await getCurrentSession();
  if (!session || session.user.mustChangePassword)
    return Response.json({ error: 'Sign in required.' }, { status: 401 });
  const { storeId } = await params;
  try {
    return Response.json(await listShopifyImports(getDatabase(), principalOf(session.user), storeId), {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    if (isAuthError(error)) return Response.json({ error: 'Store not found.' }, { status: 404 });
    return Response.json({ error: 'Unable to refresh import progress.' }, { status: 500 });
  }
}
