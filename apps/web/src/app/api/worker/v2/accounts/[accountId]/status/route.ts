import { workerApi } from '../../../_lib';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, { params }: { params: Promise<{ accountId: string }> }) {
  return workerApi.dispatch(request, 'account-status', (await params).accountId);
}
