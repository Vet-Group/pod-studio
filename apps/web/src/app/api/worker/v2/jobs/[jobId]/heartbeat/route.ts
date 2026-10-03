import { workerApi } from '../../../_lib';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  return workerApi.dispatch(request, 'heartbeat', (await params).jobId);
}
