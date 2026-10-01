import { AssetError, AuthError, createDesign, finalizeUpload, getAssetUrl, getDesignUrl, isAuthError, listDesigns, requestUpload, shareDesign, type Principal } from '@pod-studio/core';
import { isId } from '@pod-studio/db';
import { getStorage } from '@/features/designs/storage';
import { getDatabase } from '@/lib/auth';
import { principalOf } from '@/lib/principal';
import { getCurrentSession } from '@/lib/session';

export const runtime = 'nodejs';
const response = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });

async function currentPrincipal(): Promise<Principal> {
  const session = await getCurrentSession();
  if (!session || session.user.mustChangePassword) throw new AuthError('FORBIDDEN');
  return principalOf(session.user);
}
function id(value: unknown): string {
  if (!isId(value)) throw new AssetError('INVALID_INPUT');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new AssetError('INVALID_INPUT');
  return value;
}
async function run(operation: () => Promise<unknown>) {
  try {
    return response({ ok: true, data: await operation() });
  } catch (error) {
    if (isAuthError(error)) return response({ ok: false, error: error.message, code: error.code }, 403);
    if (error instanceof AssetError) return response({ ok: false, error: error.message, code: error.code }, error.code === 'NOT_FOUND' ? 404 : 400);
    throw error;
  }
}

/** List metadata or mint a short-lived read capability after checking the current store grant. */
export async function GET(request: Request) {
  return run(async () => {
    const principal = await currentPrincipal();
    const query = new URL(request.url).searchParams;
    const storeId = id(query.get('storeId'));
    const designId = query.get('designId');
    const assetId = query.get('assetId');
    if (designId && assetId) throw new AssetError('INVALID_INPUT');
    if (designId) return getDesignUrl(getDatabase(), getStorage(), principal, { storeId, designId: id(designId) });
    if (assetId) return getAssetUrl(getDatabase(), getStorage(), principal, { storeId, assetId: id(assetId) });
    return listDesigns(getDatabase(), principal, storeId);
  });
}

/** Browser bytes go straight to S3; the app receives only declarations and upload IDs. */
export async function POST(request: Request) {
  return run(async () => {
    const principal = await currentPrincipal();
    // Next may normalize request.url to its internal hostname behind a proxy. The configured
    // auth origin is the browser-facing origin, not a caller-controlled Host/Forwarded header.
    const appOrigin = new URL(process.env.BETTER_AUTH_URL!).origin;
    if (request.headers.get('origin') !== appOrigin) throw new AuthError('FORBIDDEN');
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AssetError('INVALID_INPUT');
    let body: Record<string, unknown>;
    try { body = await request.json(); } catch { throw new AssetError('INVALID_INPUT'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AssetError('INVALID_INPUT');
    const storeId = id(body.storeId);
    const db = getDatabase();
    switch (body.operation) {
      case 'request-upload':
        if (typeof body.sizeBytes !== 'number') throw new AssetError('INVALID_INPUT');
        return requestUpload(db, getStorage(), principal, { storeId, sha256: text(body.sha256), contentType: text(body.contentType), sizeBytes: body.sizeBytes });
      case 'finalize-upload':
        return finalizeUpload(db, getStorage(), principal, { storeId, uploadId: id(body.uploadId) });
      case 'create':
        return createDesign(db, principal, { storeId, assetId: id(body.assetId), name: text(body.name) });
      case 'share':
        return shareDesign(db, principal, { storeId, designId: id(body.designId), targetStoreId: id(body.targetStoreId) });
      default: throw new AssetError('INVALID_INPUT');
    }
  });
}
