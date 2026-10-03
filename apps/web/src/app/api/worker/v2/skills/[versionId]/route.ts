import { workerApi } from '../../_lib';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ versionId: string }> }) {
  return workerApi.dispatch(request, 'skill-version', (await params).versionId);
}
