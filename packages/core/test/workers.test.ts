import { describe, expect, it } from 'vitest';
import { auditLog, eq, users, workers, workerIdempotency } from '@pod-studio/db';
import { authenticateWorker, createWorkerToken, hashWorkerToken, provisionWorker, revokeWorker, verifyWorkerToken } from '../src/workers/tokens';
import { withDurableIdempotency } from '../src/workers/idempotency';
import { harness } from './generation/harness';

describe('worker credentials', () => {
  it('uses high entropy opaque values and constant-time digest verification', () => {
    const issued = createWorkerToken();
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashWorkerToken(issued.token)).toBe(issued.hash);
    expect(verifyWorkerToken(issued.token, issued.hash)).toBe(true);
    expect(verifyWorkerToken(`${issued.token}x`, issued.hash)).toBe(false);
    expect(verifyWorkerToken(issued.token, 'not-a-hash')).toBe(false);
    expect(verifyWorkerToken('x'.repeat(1000), issued.hash)).toBe(false);
    expect(createWorkerToken().token).not.toBe(issued.token);
  });
});

describe('worker credential lifecycle', () => {
  it('requires an administrator and rotates/revokes tokens with secret-free audit rows', async () => {
    const { db } = await harness();
    const admin = { userId: 'credential_admin', role: 'admin' as const };
    const member = { userId: 'requester_owner', role: 'member' as const };
    await db.insert(users).values({ id: admin.userId, name: 'Credential admin', email: 'credential-admin@example.test', role: 'admin' });
    const input = { workerKey: 'credential-worker', host: 'host', version: '1.0.0' };
    await expect(provisionWorker(db, member, input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const issued = await provisionWorker(db, admin, input);
    await expect(revokeWorker(db, member, issued.workerId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await authenticateWorker(db, issued.token))!.id).toBe(issued.workerId);
    const rotated = await provisionWorker(db, admin, input);
    expect(rotated.workerId).toBe(issued.workerId);
    expect(rotated.token).not.toBe(issued.token);
    expect(await authenticateWorker(db, issued.token)).toBeNull();
    expect((await authenticateWorker(db, rotated.token))!.id).toBe(issued.workerId);
    await revokeWorker(db, admin, issued.workerId);
    expect(await authenticateWorker(db, rotated.token)).toBeNull();
    const [stored] = await db.select().from(workers).where(eq(workers.id, issued.workerId));
    expect(stored!.tokenHash).toBe(hashWorkerToken(rotated.token));
    const audits = await db.select().from(auditLog);
    expect(audits).toHaveLength(3);
    expect(JSON.stringify(audits)).not.toContain(issued.token);
    expect(JSON.stringify(audits)).not.toContain(rotated.token);
  });
});

describe('durable worker idempotency', () => {
  it('rolls back the replay row and callback writes together, then retries safely', async () => {
    const { db, workerId } = await harness();
    const scope = { workerId, jobId: 'job_rollback', operation: 'fail', key: 'rollback-key' };
    await expect(withDurableIdempotency(db, scope, { a: 1, b: 2 }, async (tx) => {
      await tx.update(workers).set({ host: 'must-rollback' }).where(eq(workers.id, workerId));
      throw new Error('Injected database failure');
    })).rejects.toThrow('Injected database failure');
    const [worker] = await db.select().from(workers).where(eq(workers.id, workerId));
    expect(worker!.host).toBe('test-host');
    expect(await db.select().from(workerIdempotency)).toHaveLength(0);
    const first = await withDurableIdempotency(db, scope, { a: 1, b: 2 }, () => Promise.resolve({ status: 200, response: { ok: true } }));
    const second = await withDurableIdempotency(db, scope, { b: 2, a: 1 }, () => { throw new Error('Replay must not run callback'); });
    expect(second).toEqual(first);
  });

  it('replays the first response and rejects changed bodies across concurrent calls', async () => {
    const { db, workerId } = await harness();
    const scope = { workerId, jobId: 'job_idempotency', operation: 'complete', key: 'key-12345678' };
    let calls = 0;
    const operation = () => { calls++; return Promise.resolve({ status: 200, response: { status: 'succeeded', resultIds: ['result-one'] } }); };
    const results = await Promise.all([1, 2, 3, 4].map(() => withDurableIdempotency(db, scope, { leaseToken: 'lease' }, operation)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(calls).toBe(1);
    expect(await withDurableIdempotency(db, scope, { leaseToken: 'different' }, operation)).toMatchObject({ status: 422, response: { code: 'idempotency_key_reused' } });
    expect(await db.select().from(workerIdempotency).where(eq(workerIdempotency.workerId, workerId))).toHaveLength(1);
  });
});
