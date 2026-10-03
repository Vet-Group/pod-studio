import { assertContract, validateContract, type components, type ContractSchemaName } from '@pod-studio/contracts';
import {
  apiProblem, authenticateWorker, claimWorkerJob, completeWorkerJob, createWorkerUploads,
  failWorkerJob, getSkillVersion, heartbeatWorkerJob, registerWorker, updateAccountStatus,
  WorkerApiError, type Storage,
} from '@pod-studio/core';
import type { Database } from '@pod-studio/db';

export type WorkerOperation = 'register' | 'claim' | 'heartbeat' | 'uploads' | 'complete' | 'fail' | 'account-status' | 'skill-version';
export const MAX_WORKER_BODY_BYTES = 1024 * 1024;
export const DEFAULT_CLAIM_WAIT_SECONDS = 0;
const MAX_REQUESTS_PER_MINUTE = 120;
const MAX_ACTIVE_POLLS = 4;
const ID = /^[A-Za-z0-9_-]{8,40}$/;

type Dependencies = { database: () => Database; storage: () => Storage; now?: () => Date };
type Bucket = { requests: number; resetAt: number; activePolls: number };

function json(value: unknown, schema: ContractSchemaName, status = 200): Response {
  assertContract(schema, value);
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}
function noJob(): Response { return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } }); }

async function body(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new WorkerApiError('validation_failed', 400);
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_WORKER_BODY_BYTES)) throw new WorkerApiError('validation_failed', 400, 'The request body is too large.');
  if (!request.body) throw new WorkerApiError('validation_failed', 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (request.signal.aborted) throw new WorkerApiError('validation_failed', 400, 'Request aborted.');
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_WORKER_BODY_BYTES) {
        await reader.cancel();
        throw new WorkerApiError('validation_failed', 400, 'The request body is too large.');
      }
      chunks.push(result.value);
    }
    const data = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as unknown;
  } catch (error) {
    if (error instanceof WorkerApiError) throw error;
    throw new WorkerApiError('validation_failed', 400, 'Invalid JSON body.');
  } finally { reader.releaseLock(); }
}

function validate<T>(schema: ContractSchemaName, value: unknown): T {
  const errors = validateContract(schema, value);
  if (errors.length) throw new WorkerApiError('validation_failed', 400, 'The request does not match the worker contract.', errors);
  return value as T;
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

/** HTTP boundary shared by the real Next routes and isolated contract integration tests. */
export function createWorkerApi(dependencies: Dependencies) {
  const buckets = new Map<string, Bucket>();
  const now = dependencies.now ?? (() => new Date());
  async function dispatch(request: Request, operation: WorkerOperation, id?: string): Promise<Response> {
    let bucket: Bucket | undefined;
    let polling = false;
    try {
      if (request.headers.get('x-contract-version') !== '2') throw new WorkerApiError('contract_version_unsupported', 426);
      const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      const db = dependencies.database();
      const worker = token ? await authenticateWorker(db, token) : null;
      if (!worker) throw new WorkerApiError('unauthorized', 401);
      const time = Date.now();
      for (const [key, entry] of buckets) if (entry.resetAt <= time && !entry.activePolls) buckets.delete(key);
      bucket = buckets.get(worker.id);
      if (!bucket) { bucket = { requests: 0, resetAt: time + 60_000, activePolls: 0 }; buckets.set(worker.id, bucket); }
      if (bucket.resetAt <= time) { bucket.requests = 0; bucket.resetAt = time + 60_000; }
      if (++bucket.requests > MAX_REQUESTS_PER_MINUTE) throw new WorkerApiError('rate_limited', 429);
      if (id !== undefined && !ID.test(id)) throw new WorkerApiError('validation_failed', 400);
      if (operation === 'skill-version') return json(await getSkillVersion(db, dependencies.storage(), id ?? ''), 'SkillVersionResponse');
      const input = await body(request);
      switch (operation) {
        case 'register':
          return json(await registerWorker(db, worker, input, now()), 'RegisterResponse');
        case 'claim': {
          const claim = validate<components['schemas']['ClaimRequest']>('ClaimRequest', input);
          if (claim.workerId !== worker.id) throw new WorkerApiError('unauthorized', 401);
          const wait = claim.waitSeconds ?? DEFAULT_CLAIM_WAIT_SECONDS;
          if (bucket.activePolls >= MAX_ACTIVE_POLLS) throw new WorkerApiError('rate_limited', 429);
          bucket.activePolls++; polling = true;
          const deadline = Date.now() + wait * 1000;
          let nextAuthentication = Date.now() + 5000;
          do {
            if (request.signal.aborted) return noJob();
            if (Date.now() >= nextAuthentication) {
              if (!(await authenticateWorker(db, token!))) throw new WorkerApiError('unauthorized', 401);
              nextAuthentication = Date.now() + 5000;
            }
            const result = await claimWorkerJob(db, dependencies.storage(), worker.id, claim.accountId, claim.jobTypes, now(), request.signal);
            if (result) return json(result, 'ClaimResponse');
            if (Date.now() >= deadline) return noJob();
            await pause(Math.min(1000 + Math.floor(Math.random() * 250), deadline - Date.now()), request.signal);
          } while (!request.signal.aborted);
          return noJob();
        }
        case 'heartbeat':
          return json(await heartbeatWorkerJob(db, worker.id, id ?? '', input, now()), 'HeartbeatResponse');
        case 'uploads':
          return json(await createWorkerUploads(db, dependencies.storage(), worker.id, id ?? '', input, now()), 'UploadsResponse');
        case 'complete':
        case 'fail': {
          const key = request.headers.get('idempotency-key') ?? '';
          const result = operation === 'complete'
            ? await completeWorkerJob(db, dependencies.storage(), worker.id, id ?? '', key, input, now())
            : await failWorkerJob(db, worker.id, id ?? '', key, input, now());
          return result.status >= 400 ? problemResponse(result.response, result.status) : json(result.response, operation === 'complete' ? 'CompleteResponse' : 'FailResponse', result.status);
        }
        case 'account-status':
          return json(await updateAccountStatus(db, worker.id, id ?? '', input, now()), 'AccountStatusResponse');
      }
      throw new WorkerApiError('not_found', 404);
    } catch (error) {
      const details = apiProblem(error);
      return problemResponse(details, details.status);
    } finally { if (polling && bucket) bucket.activePolls--; }
  }
  return { dispatch };
}
function problemResponse(value: unknown, status: number): Response {
  assertContract('Problem', value);
  return Response.json(value, { status, headers: { 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store', ...(status === 429 ? { 'Retry-After': '60' } : {}) } });
}
