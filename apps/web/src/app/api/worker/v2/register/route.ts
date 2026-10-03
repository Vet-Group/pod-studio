import { workerApi } from '../_lib';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) { return workerApi.dispatch(request, 'register'); }
