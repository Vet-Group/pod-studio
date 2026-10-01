import { sql } from '@pod-studio/db';
import { getDatabase } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Readiness probe: 200 when the app can reach Postgres, 503 otherwise. Public like /api/health
 * (no account data) and deliberately silent about the failure reason, which only goes to the log.
 */
export async function GET() {
  try {
    await getDatabase().execute(sql`select 1`);
    return Response.json({ ok: true, service: 'pod-studio-web', database: 'up' });
  } catch (error) {
    console.error('[ready] database check failed:', error instanceof Error ? error.message : String(error));
    return Response.json({ ok: false, service: 'pod-studio-web', database: 'down' }, { status: 503 });
  }
}
