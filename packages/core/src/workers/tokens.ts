import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq, newId, workers, type Database } from '@pod-studio/db';
import { writeAudit } from '../audit/log';
import type { Principal } from '../access';
import { AuthError } from '../auth/errors';

const TOKEN_RE = /^[A-Za-z0-9_-]{43,128}$/;

/** Worker credentials are opaque high entropy values. Only this digest is persisted. */
export function createWorkerToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashWorkerToken(token) };
}
export function hashWorkerToken(token: string): string {
  if (typeof token !== 'string') throw new TypeError('Worker token must be a string.');
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
export function verifyWorkerToken(token: string, expectedHash: string): boolean {
  if (typeof token !== 'string' || !TOKEN_RE.test(token) || typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedHash)) return false;
  const actual = Buffer.from(hashWorkerToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Provisioning is an admin-only core action. The plaintext token is returned exactly once. */
export async function provisionWorker(db: Database, principal: Principal, input: { workerKey: string; host: string; version: string }, now = new Date()) {
  if (principal.role !== 'admin') throw new AuthError('FORBIDDEN');
  if (!/^[a-z0-9][a-z0-9_.@-]{1,99}$/.test(input.workerKey) || input.host.length > 255 || input.version.length > 64) throw new AuthError('INVALID_INPUT');
  const issued = createWorkerToken();
  const worker = await db.transaction(async (tx) => {
    const [row] = await tx.insert(workers).values({ id: newId(), workerKey: input.workerKey, host: input.host, version: input.version, tokenHash: issued.hash, tokenRevokedAt: null, state: 'active', createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: workers.workerKey, set: { host: input.host, version: input.version, tokenHash: issued.hash, tokenRevokedAt: null, state: 'active', updatedAt: now } }).returning();
    await writeAudit(tx, { actorUserId: principal.userId, action: 'worker.provision', targetType: 'worker', targetId: row!.id, data: { workerKey: input.workerKey } });
    return row!;
  });
  return { workerId: worker.id, workerKey: worker.workerKey, token: issued.token };
}

export async function revokeWorker(db: Database, principal: Principal, workerId: string, now = new Date()) {
  if (principal.role !== 'admin') throw new AuthError('FORBIDDEN');
  const [worker] = await db.transaction(async (tx) => {
    const [row] = await tx.update(workers).set({ state: 'disabled', tokenRevokedAt: now, updatedAt: now }).where(eq(workers.id, workerId)).returning();
    if (row) await writeAudit(tx, { actorUserId: principal.userId, action: 'worker.revoke', targetType: 'worker', targetId: workerId });
    return [row];
  });
  if (!worker) throw new AuthError('NOT_FOUND');
  return { workerId, state: worker.state };
}

export async function authenticateWorker(db: Database, token: string) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const rows = await db.select().from(workers).where(eq(workers.tokenHash, hashWorkerToken(token)));
  const worker = rows[0];
  if (!worker || worker.state !== 'active' || worker.tokenRevokedAt) return null;
  return verifyWorkerToken(token, worker.tokenHash ?? '') ? worker : null;
}
