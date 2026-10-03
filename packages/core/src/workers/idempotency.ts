import { createHash } from 'node:crypto';
import { and, eq, newId, sql, workerIdempotency, type Database } from '@pod-studio/db';
import type { Executor } from '../audit/log';

export interface IdempotencyResult { status: number; response: unknown }
export interface DurableIdempotencyScope { workerId: string; jobId: string; operation: string; key: string }

/** Canonical JSON: property order is irrelevant, array order remains meaningful. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
}
export function requestDigest(scope: DurableIdempotencyScope, body: unknown): string {
  return createHash('sha256').update(canonicalJson({ ...scope, body }), 'utf8').digest('hex');
}

/** Prepare external I/O without locks; commit the transition and replay record atomically. */
export async function withDurableIdempotency<T extends IdempotencyResult, Prepared = undefined>(
  db: Database,
  scope: DurableIdempotencyScope,
  body: unknown,
  operation: (tx: Executor, prepared: Prepared) => Promise<T>,
  prepare?: () => Promise<Prepared>,
): Promise<T> {
  const requestHash = requestDigest(scope, body);
  const where = and(eq(workerIdempotency.workerId, scope.workerId), eq(workerIdempotency.jobId, scope.jobId), eq(workerIdempotency.key, scope.key));
  const replay = (row: typeof workerIdempotency.$inferSelect | undefined): T | undefined => {
    if (!row) return undefined;
    if (row.requestHash !== requestHash) return { status: 422, response: problem('idempotency_key_reused') } as T;
    if (row.status !== 'done' || !row.response) throw new Error('Invalid durable idempotency record.');
    return JSON.parse(row.response) as T;
  };
  const [prior] = await db.select().from(workerIdempotency).where(where);
  const first = replay(prior);
  if (first) return first;
  const prepared = prepare ? await prepare() : undefined as Prepared;
  return db.transaction(async (tx) => {
    // All instances share this lock. It encloses database work only, never object-store I/O.
    const lock = canonicalJson([scope.workerId, scope.jobId, scope.key]);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lock}, 0))`);
    const [existing] = await tx.select().from(workerIdempotency).where(where);
    const duplicate = replay(existing);
    if (duplicate) return duplicate;
    const result = await operation(tx, prepared);
    await tx.insert(workerIdempotency).values({ id: newId(), ...scope, requestHash, status: 'done', response: JSON.stringify(result) });
    return result;
  });
}

export function problem(code: string, status = 422) {
  return { type: `https://pod-studio.invalid/problems/${code}`, title: code, status, code };
}
export async function withIdempotency<T extends IdempotencyResult>(db: Database, scope: string, key: string, body: unknown, operation: (tx: Executor) => Promise<T>) {
  const [workerId, jobId, operationName] = scope.split(':');
  return withDurableIdempotency(db, { workerId: workerId ?? scope, jobId: jobId ?? '-', operation: operationName ?? 'legacy', key }, body, operation);
}
