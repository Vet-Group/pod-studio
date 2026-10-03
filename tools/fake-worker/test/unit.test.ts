import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { hostname } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateContract } from '@pod-studio/contracts';
import type { ClaimedJob, RegisterResponse, WorkerClient } from '../src/client';
import { main, parseArgs } from '../src/index';
import { runScenario, scenarios } from '../src/scenarios';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const input = Buffer.from('verified input asset');
const registration: RegisterResponse = {
  workerId: 'worker_123', accounts: [{ accountKey: 'fake-account', accountId: 'account_123', state: 'available' }],
  storageOrigins: ['https://storage.example'], heartbeatIntervalSeconds: 1, leaseSeconds: 30, maxClaimWaitSeconds: 20,
};
const asset = {
  role: 'design' as const, assetId: 'asset_123', url: 'https://storage.example/input?signature=secret',
  urlExpiresAt: '2099-01-01T00:00:00Z', sha256: sha(input), contentType: 'image/png', bytes: input.length, filename: 'input.png',
};
function imageJob(): ClaimedJob {
  return {
    id: 'job_12345', type: 'mockup', provider: 'gemini', model: 'imagen-4', attempt: 1, maxAttempts: 3,
    leaseToken: 'test-lease-token-123', leaseExpiresAt: '2099-01-01T00:00:00Z', prompt: 'Test prompt', inputs: [asset],
    params: { productType: 'shirt', count: 2, ratio: '3:4', minLongEdge: 512, mode: 'generate' },
  };
}
function textJob(type: 'listing_content' | 'product_analysis'): ClaimedJob {
  const base = imageJob();
  return type === 'listing_content'
    ? { ...base, type, params: { locale: 'en', niche: 'hiking', productType: 'shirt', takenKeywords: ['hiking'] } }
    : { ...base, type, params: { locale: 'en', niche: 'hiking', productType: 'shirt' } };
}
function setup() {
  const client = {
    heartbeat: vi.fn().mockResolvedValue({ leaseExpiresAt: '2099-01-01T00:00:00Z', cancelRequested: false }),
    uploads: vi.fn().mockImplementation(async (_id: string, request: { files: unknown[] }) => ({
      uploads: request.files.map((_, i) => ({
        uploadKey: `upload-key-${i}`, url: `https://storage.example/output-${i}?signature=secret`, method: 'PUT',
        headers: { 'Content-Type': 'image/png', 'x-upload-required': 'yes' }, expiresAt: '2099-01-01T00:00:00Z',
      })),
    })),
    complete: vi.fn().mockResolvedValue({ status: 'succeeded', resultIds: ['result_123'] }),
    fail: vi.fn().mockResolvedValue({ jobStatus: 'failed', willRetry: false }),
  };
  const fetch = vi.fn().mockImplementation(async (_url: unknown, init?: RequestInit) =>
    init?.method === 'PUT' ? new Response(null, { status: 200 }) : new Response(input, { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  return { client, fetch, worker: client as unknown as WorkerClient };
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function inspectPng(bytes: Buffer) {
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const chunks: Array<{ type: string; data: Buffer }> = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    expect(bytes.readUInt32BE(offset + 8 + length)).toBe(crc32(bytes.subarray(offset + 4, offset + 8 + length)));
    chunks.push({ type, data });
    offset += length + 12;
    if (type === 'IEND') expect(offset).toBe(bytes.length);
  }
  expect(chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
  const header = chunks[0]!.data;
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4);
  expect(header.subarray(8)).toEqual(Buffer.from([8, 2, 0, 0, 0]));
  const pixels = inflateSync(chunks[1]!.data);
  expect(pixels.length).toBe((width * 3 + 1) * height);
  for (let row = 0; row < height; row++) expect(pixels[row * (width * 3 + 1)]).toBe(0);
  return { width, height };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('scenario runner', () => {
  it('exports all six stable scenario names', () => {
    expect(scenarios).toEqual(['success', 'slow', 'rate_limit', 'expired_session', 'lease_timeout', 'checksum_mismatch']);
  });

  it('downloads and verifies inputs, then uploads genuine PNGs with exact declarations', async () => {
    const { client, worker, fetch } = setup();
    expect(await runScenario(worker, imageJob(), registration, 'success')).toEqual({ outcome: 'completed', heartbeatCount: 0 });
    expect(validateContract('UploadsRequest', client.uploads.mock.calls[0]![1])).toEqual([]);
    const completion = client.complete.mock.calls[0]![1];
    expect(validateContract('CompleteRequest', completion)).toEqual([]);
    expect(completion.images).toHaveLength(2);
    expect(new Set(completion.images.map((image: { sha256: string }) => image.sha256)).size).toBe(2);
    const puts = fetch.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(puts).toHaveLength(2);
    for (let i = 0; i < puts.length; i++) {
      const init = puts[i]![1] as RequestInit;
      const bytes = Buffer.from(init.body as Uint8Array);
      const dimensions = inspectPng(bytes);
      expect(dimensions).toEqual({ width: 384, height: 512 });
      const declaration = client.uploads.mock.calls[0]![1].files[i];
      expect(declaration).toEqual({ contentType: 'image/png', bytes: bytes.length, sha256: sha(bytes) });
      expect(completion.images[i]).toMatchObject({ ...declaration, ...dimensions, uploadKey: `upload-key-${i}` });
      expect(new Headers(init.headers).get('x-upload-required')).toBe('yes');
    }
    for (const [, init] of fetch.mock.calls) {
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
    }
    expect(client.heartbeat).not.toHaveBeenCalled();
  });

  it('supports redesign output quantity, ratio and a non-divisible long edge', async () => {
    const { client, worker, fetch } = setup();
    const job: ClaimedJob = { ...imageJob(), type: 'redesign', params: { count: 1, ratio: '16:9', minLongEdge: 513, intent: 'variation' } };
    await runScenario(worker, job, registration, 'success');
    const put = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    const dimensions = inspectPng(Buffer.from(put[1].body as Uint8Array));
    expect(dimensions.width).toBeGreaterThanOrEqual(513);
    expect(dimensions.width / dimensions.height).toBe(16 / 9);
    expect(client.complete.mock.calls[0]![1].images).toHaveLength(1);
  });

  it.each(['listing_content', 'product_analysis'] as const)('completes %s with schema-valid JSON and no uploads', async (type) => {
    const { client, worker } = setup();
    expect((await runScenario(worker, textJob(type), registration, 'success')).outcome).toBe('completed');
    const complete = client.complete.mock.calls[0]![1];
    expect(validateContract('CompleteRequest', complete)).toEqual([]);
    expect(validateContract(type === 'listing_content' ? 'ListingContentPayload' : 'ProductAnalysisPayload', complete.payload)).toEqual([]);
    expect(complete.payload.locale).toBe('en');
    expect(client.uploads).not.toHaveBeenCalled();
    if (type === 'listing_content') expect(complete.payload.tags).not.toContain('hiking');
  });

  it.each([
    ['rate_limit', 'account_rate_limited'], ['expired_session', 'account_session_expired'],
  ] as const)('%s sends the precise contract error class', async (scenario, errorClass) => {
    const { client, worker, fetch } = setup();
    expect(await runScenario(worker, imageJob(), registration, scenario)).toEqual({ outcome: 'failed', heartbeatCount: 0 });
    const request = client.fail.mock.calls[0]![1];
    expect(request).toMatchObject({ leaseToken: 'test-lease-token-123', errorClass });
    expect(validateContract('FailRequest', request)).toEqual([]);
    expect(client.complete).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('abandons a lease without any API or storage work', async () => {
    const { client, worker, fetch } = setup();
    expect(await runScenario(worker, imageJob(), registration, 'lease_timeout')).toEqual({ outcome: 'abandoned', heartbeatCount: 0 });
    for (const spy of Object.values(client)) expect(spy).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps upload bytes and declarations valid, corrupting only completion SHA', async () => {
    const { client, worker, fetch } = setup();
    client.complete.mockRejectedValue(Object.assign(new Error('Completion rejected'), { status: 422, code: 'checksum_mismatch' }));
    expect(await runScenario(worker, imageJob(), registration, 'checksum_mismatch')).toEqual({ outcome: 'rejected', heartbeatCount: 0 });
    const declaration = client.uploads.mock.calls[0]![1].files[0];
    const put = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(sha(Buffer.from(put[1].body as Uint8Array))).toBe(declaration.sha256);
    const completion = client.complete.mock.calls[0]![1];
    expect(completion.images[0].sha256).not.toBe(declaration.sha256);
    expect(validateContract('CompleteRequest', completion)).toEqual([]);
    expect(client.fail).not.toHaveBeenCalled();
  });

  it('does not claim checksum rejection when the server accepted it or failed for another reason', async () => {
    const { client, worker } = setup();
    await expect(runScenario(worker, imageJob(), registration, 'checksum_mismatch')).rejects.toThrow(/accepted/i);
    client.complete.mockRejectedValue(Object.assign(new Error('Unrelated failure'), { status: 422, code: 'upload_missing' }));
    await expect(runScenario(worker, imageJob(), registration, 'checksum_mismatch')).rejects.toThrow('Unrelated failure');
  });

  it.each(['listing_content', 'product_analysis'] as const)('clearly rejects checksum_mismatch for %s', async (type) => {
    const { client, worker, fetch } = setup();
    await expect(runScenario(worker, textJob(type), registration, 'checksum_mismatch')).rejects.toThrow(/unsupported.*text/i);
    expect(client.complete).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'https://evil.example/input', 'https://storage.example.evil/input',
    'http://storage.example/input', 'https://user:password@storage.example/input', 'file:///input.png',
  ])('rejects unsafe input URL %s without requesting it', async (url) => {
    const { client, worker, fetch } = setup();
    const job = imageJob(); job.inputs = [{ ...asset, url }];
    await expect(runScenario(worker, job, registration, 'success')).rejects.toThrow(/storage URL/i);
    expect(fetch).not.toHaveBeenCalled();
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('checks all input origins before any download', async () => {
    const { worker, fetch } = setup();
    const job = imageJob(); job.inputs.push({ ...asset, url: 'https://evil.example/input' });
    await expect(runScenario(worker, job, registration, 'success')).rejects.toThrow(/storage URL/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('detects incorrect input checksums and sizes before declaring uploads', async () => {
    const { client, worker } = setup();
    const job = imageJob(); job.inputs = [{ ...asset, sha256: '0'.repeat(64) }];
    await expect(runScenario(worker, job, registration, 'success')).rejects.toThrow(/checksum/i);
    job.inputs = [{ ...asset, bytes: input.length + 1 }];
    await expect(runScenario(worker, job, registration, 'success')).rejects.toThrow(/size/i);
    expect(client.uploads).not.toHaveBeenCalled();
  });

  it('rejects redirects and failed storage responses with sanitized messages', async () => {
    const { worker, fetch } = setup();
    fetch.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://evil.example/?token=secret' } }));
    await expect(runScenario(worker, imageJob(), registration, 'success')).rejects.toThrow(/storage download/i);
    fetch.mockRejectedValue(new Error('https://storage.example/?signature=secret'));
    await expect(runScenario(worker, imageJob(), registration, 'success')).rejects.toThrow(/^Storage download failed$/);
  });

  it('rejects unsafe upload origins and authorization headers without PUT or completion', async () => {
    const { client, worker, fetch } = setup();
    const target = { uploadKey: 'upload-key', url: 'https://evil.example/output', method: 'PUT', headers: {}, expiresAt: '2099-01-01T00:00:00Z' };
    client.uploads.mockResolvedValue({ uploads: [target, target] });
    await expect(runScenario(worker, imageJob(), registration, 'success')).rejects.toThrow(/storage URL/i);
    target.url = 'https://storage.example/output';
    target.headers = { Authorization: 'Bearer must-not-be-sent' };
    await expect(runScenario(worker, imageJob(), registration, 'success')).rejects.toThrow(/authorization/i);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('requires an upload target for every declared image and checks PUT success', async () => {
    const { client, worker, fetch } = setup();
    client.uploads.mockResolvedValueOnce({ uploads: [] });
    await expect(runScenario(worker, imageJob(), registration, 'success')).rejects.toThrow(/upload target/i);
    fetch.mockImplementation(async (_url, init) => init?.method === 'PUT' ? new Response(null, { status: 403 }) : new Response(input));
    await expect(runScenario(worker, imageJob(), registration, 'success')).rejects.toThrow(/storage upload/i);
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('heartbeats at registration cadence during slow work', async () => {
    vi.useFakeTimers();
    const { client, worker } = setup();
    const run = runScenario(worker, textJob('listing_content'), registration, 'slow', { slowDurationMs: 2500 });
    await vi.advanceTimersByTimeAsync(999);
    expect(client.heartbeat).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1001);
    expect(client.heartbeat).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(await run).toEqual({ outcome: 'completed', heartbeatCount: 2 });
    expect(validateContract('HeartbeatRequest', client.heartbeat.mock.calls[0]![1])).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.heartbeat).toHaveBeenCalledTimes(2);
  });

  it('keeps heartbeat start times on the registered cadence despite response latency', async () => {
    vi.useFakeTimers();
    const { client, worker } = setup();
    const starts: number[] = [];
    const start = Date.now();
    client.heartbeat.mockImplementation(async () => {
      starts.push(Date.now() - start);
      await new Promise((resolve) => setTimeout(resolve, 6));
      return { leaseExpiresAt: '2099-01-01T00:00:00Z', cancelRequested: false };
    });
    const run = runScenario(worker, textJob('listing_content'), registration, 'slow', { slowDurationMs: 35, heartbeatIntervalMs: 10 });
    await vi.advanceTimersByTimeAsync(40);
    expect(await run).toEqual({ outcome: 'completed', heartbeatCount: 3 });
    expect(starts).toEqual([10, 20, 30]);
  });

  it('honors the test cadence override and acknowledges cancellation, stopping all output', async () => {
    vi.useFakeTimers();
    const { client, worker } = setup();
    client.heartbeat.mockResolvedValue({ leaseExpiresAt: '2099-01-01T00:00:00Z', cancelRequested: true });
    const run = runScenario(worker, imageJob(), registration, 'slow', { slowDurationMs: 5000, heartbeatIntervalMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await run).toEqual({ outcome: 'failed', heartbeatCount: 1 });
    expect(client.fail.mock.calls[0]![1]).toMatchObject({ errorClass: 'cancelled', leaseToken: 'test-lease-token-123' });
    expect(validateContract('FailRequest', client.fail.mock.calls[0]![1])).toEqual([]);
    expect(client.uploads).not.toHaveBeenCalled();
    expect(client.complete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10000);
    expect(client.heartbeat).toHaveBeenCalledTimes(1);
  });

  it('stops a slow scenario on lease loss without stale fail or complete', async () => {
    vi.useFakeTimers();
    const { client, worker } = setup();
    client.heartbeat.mockRejectedValue(Object.assign(new Error('Lease lost'), { status: 409, code: 'lease_lost' }));
    const run = runScenario(worker, imageJob(), registration, 'slow', { slowDurationMs: 50, heartbeatIntervalMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await run).toEqual({ outcome: 'abandoned', heartbeatCount: 1 });
    expect(client.fail).not.toHaveBeenCalled(); expect(client.complete).not.toHaveBeenCalled();
  });

  it('rejects invalid timing options before executing work', async () => {
    const { worker, fetch } = setup();
    await expect(runScenario(worker, imageJob(), registration, 'slow', { heartbeatIntervalMs: 0 })).rejects.toThrow(/heartbeatIntervalMs/);
    await expect(runScenario(worker, imageJob(), registration, 'slow', { slowDurationMs: -1 })).rejects.toThrow(/slowDurationMs/);
    await expect(runScenario(worker, imageJob(), registration, 'success', { maxStagedBytes: 0 })).rejects.toThrow(/maxStagedBytes/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('cancellation through heartbeat, retry and storage I/O', () => {
  afterEach(() => { vi.useRealTimers(); });
  const idle = { leaseExpiresAt: '2099-01-01T00:00:00Z', cancelRequested: false };
  /** A heartbeat that hangs, like a client sleeping in retry backoff, until its signal aborts. */
  const hangingHeartbeat = (seen: AbortSignal[]) => (_id: string, _body: unknown, signal?: AbortSignal) => new Promise((_resolve, reject) => {
    if (signal) { seen.push(signal); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }
  });

  it('passes an abort signal to every heartbeat so retry backoff is cancellable', async () => {
    vi.useFakeTimers();
    const { client, worker } = setup();
    const run = runScenario(worker, textJob('listing_content'), registration, 'slow', { slowDurationMs: 25, heartbeatIntervalMs: 10 });
    await vi.advanceTimersByTimeAsync(30);
    expect(await run).toMatchObject({ outcome: 'completed' });
    for (const call of client.heartbeat.mock.calls) expect(call[2]).toBeInstanceOf(AbortSignal);
  });

  it('shutdown during generate stops work, heartbeats and their retries without fail or complete', async () => {
    vi.useFakeTimers();
    const { client, worker, fetch } = setup();
    const seen: AbortSignal[] = [];
    client.heartbeat.mockImplementation(hangingHeartbeat(seen));
    const shutdown = new AbortController();
    const run = runScenario(worker, imageJob(), registration, 'slow', { slowDurationMs: 60_000, heartbeatIntervalMs: 10, signal: shutdown.signal });
    await vi.advanceTimersByTimeAsync(15);
    expect(client.heartbeat).toHaveBeenCalledTimes(1); // Still retrying in the background.
    shutdown.abort(new Error('SIGINT'));
    expect(await run).toEqual({ outcome: 'abandoned', heartbeatCount: 1 });
    expect(seen[0]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.heartbeat).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(client.uploads).not.toHaveBeenCalled(); expect(client.complete).not.toHaveBeenCalled(); expect(client.fail).not.toHaveBeenCalled();
  });

  it('shutdown during upload aborts the in-flight PUT and skips the final write', async () => {
    const { client, worker, fetch } = setup();
    const shutdown = new AbortController();
    let putSignal: AbortSignal | undefined;
    fetch.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if (init?.method !== 'PUT') return new Response(input, { status: 200 });
      putSignal = init.signal!;
      queueMicrotask(() => shutdown.abort(new Error('SIGTERM')));
      return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
    });
    expect(await runScenario(worker, imageJob(), registration, 'success', { signal: shutdown.signal })).toEqual({ outcome: 'abandoned', heartbeatCount: 0 });
    expect(putSignal!.aborted).toBe(true);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
    expect(client.complete).not.toHaveBeenCalled(); expect(client.fail).not.toHaveBeenCalled();
  });

  it('server cancellation during upload stops further PUTs and acknowledges with fail', async () => {
    const { client, worker, fetch } = setup();
    let putStarted = false;
    // Report cancellation only once a PUT is in flight, so the abort deterministically lands mid-upload.
    client.heartbeat.mockImplementation(async () => ({ ...idle, cancelRequested: putStarted }));
    fetch.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if (init?.method !== 'PUT') return new Response(input, { status: 200 });
      putStarted = true;
      return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
    });
    const outcome = await runScenario(worker, imageJob(), registration, 'slow', { slowDurationMs: 0, heartbeatIntervalMs: 5 });
    expect(outcome.outcome).toBe('failed');
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
    expect(client.fail.mock.calls[0]![1]).toMatchObject({ errorClass: 'cancelled' });
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('a late cancel reported by a heartbeat that was retrying still beats complete', async () => {
    vi.useFakeTimers();
    const { client, worker } = setup();
    let release!: (value: typeof idle) => void;
    let callSignal: AbortSignal | undefined;
    // Like the real client, the heartbeat rejects if its signal aborts; draining must not abort it.
    client.heartbeat.mockImplementation((_id: string, _body: unknown, signal?: AbortSignal) => new Promise((resolve, reject) => {
      release = resolve; callSignal = signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const run = runScenario(worker, textJob('listing_content'), registration, 'slow', { slowDurationMs: 15, heartbeatIntervalMs: 10 });
    await vi.advanceTimersByTimeAsync(20); // Work is done; the heartbeat is still in retry backoff.
    expect(client.complete).not.toHaveBeenCalled();
    expect(callSignal!.aborted).toBe(false);
    release({ ...idle, cancelRequested: true });
    expect(await run).toEqual({ outcome: 'failed', heartbeatCount: 1 });
    expect(client.complete).not.toHaveBeenCalled();
    expect(client.fail).toHaveBeenCalledTimes(1);
  });

  it('a storage failure does not wait for a heartbeat that is still retrying', async () => {
    vi.useFakeTimers();
    const { client, worker, fetch } = setup();
    const seen: AbortSignal[] = [];
    client.heartbeat.mockImplementation(hangingHeartbeat(seen));
    fetch.mockImplementation(async (_url: unknown, init?: RequestInit) =>
      init?.method === 'PUT' ? new Response(null, { status: 500 }) : new Response(input, { status: 200 }));
    const run = runScenario(worker, imageJob(), registration, 'slow', { slowDurationMs: 15, heartbeatIntervalMs: 10 });
    const settled = expect(run).rejects.toThrow(/Storage upload failed/);
    await vi.advanceTimersByTimeAsync(20);
    await settled;
    expect(seen[0]!.aborted).toBe(true);
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('a shutdown after the final write starts keeps the real complete outcome', async () => {
    const { client, worker } = setup();
    const shutdown = new AbortController();
    client.complete.mockImplementation(async () => { shutdown.abort(new Error('SIGINT')); return { status: 'succeeded', resultIds: ['result_123'] }; });
    expect(await runScenario(worker, textJob('listing_content'), registration, 'success', { signal: shutdown.signal })).toMatchObject({ outcome: 'completed' });
  });

  it('an already-aborted signal does no work', async () => {
    const { client, worker, fetch } = setup();
    expect(await runScenario(worker, imageJob(), registration, 'success', { signal: AbortSignal.abort() })).toEqual({ outcome: 'abandoned', heartbeatCount: 0 });
    expect(fetch).not.toHaveBeenCalled(); expect(client.uploads).not.toHaveBeenCalled();
  });
});

describe('bounded output staging', () => {
  it('declares and uploads image output in batches bounded by maxStagedBytes', async () => {
    const { client, worker, fetch } = setup();
    let cursor = 0;
    client.uploads.mockImplementation(async (_id: string, request: { files: unknown[] }) => ({
      uploads: request.files.map(() => {
        const i = cursor++;
        return { uploadKey: `upload-key-${i}`, url: `https://storage.example/output-${i}?signature=secret`, method: 'PUT', headers: {}, expiresAt: '2099-01-01T00:00:00Z' };
      }),
    }));
    const job = imageJob();
    if (job.type !== 'mockup') throw new Error('expected an image job');
    job.params.count = 5;
    // A 1-byte budget flushes after every image: five /uploads calls, each declaring one file before its PUT.
    expect(await runScenario(worker, job, registration, 'success', { maxStagedBytes: 1 })).toMatchObject({ outcome: 'completed' });
    expect(client.uploads.mock.calls.map(([, request]) => request.files.length)).toEqual([1, 1, 1, 1, 1]);
    const order = [...client.uploads.mock.invocationCallOrder, ...fetch.mock.calls.flatMap(([, init], i) => init?.method === 'PUT' ? [fetch.mock.invocationCallOrder[i]!] : [])].sort((a, b) => a - b);
    const kinds = order.map((n) => client.uploads.mock.invocationCallOrder.includes(n) ? 'declare' : 'put');
    expect(kinds).toEqual(['declare', 'put', 'declare', 'put', 'declare', 'put', 'declare', 'put', 'declare', 'put']);
    const images = client.complete.mock.calls[0]![1].images as Array<{ uploadKey: string }>;
    expect(images.map((image) => image.uploadKey)).toEqual(['upload-key-0', 'upload-key-1', 'upload-key-2', 'upload-key-3', 'upload-key-4']);
  });

  it('keeps all output in one declaration under the default budget', async () => {
    const { client, worker } = setup();
    expect(await runScenario(worker, imageJob(), registration, 'success')).toMatchObject({ outcome: 'completed' });
    expect(client.uploads).toHaveBeenCalledTimes(1);
    expect(client.uploads.mock.calls[0]![1].files).toHaveLength(2);
  });
});

describe('CLI argument parsing', () => {
  it('shows help without a token or network request', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['--', '--help'], {})).toBe(0);
    expect(log.mock.calls[0]![0]).toContain('WORKER_TOKEN');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires the token environment variable before networking', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(main(['--worker-key', 'provisioned-worker'], {})).rejects.toThrow(/WORKER_TOKEN/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('registers the real hostname and claims once, capping the server wait limit', async () => {
    const token = 'T'.repeat(43);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${token}`);
      if (url.endsWith('/register')) {
        expect(validateContract('RegisterRequest', body)).toEqual([]);
        expect(body).toMatchObject({ workerKey: 'provisioned-worker', host: hostname(), accounts: [{ accountKey: 'local-account', maxConcurrency: 1 }] });
        return Response.json({ ...registration, accounts: [{ ...registration.accounts[0], accountKey: 'local-account' }], heartbeatIntervalSeconds: 5, leaseSeconds: 120, maxClaimWaitSeconds: 2 });
      }
      expect(url).toBe('http://localhost:3000/api/worker/v2/claim');
      expect(validateContract('ClaimRequest', body)).toEqual([]);
      expect(body.waitSeconds).toBe(2);
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetch);
    expect(await main(['--base-url', 'http://localhost:3000/api/worker/v2', '--worker-key', 'provisioned-worker', '--account-key', 'local-account', '--wait-seconds', '20'], { WORKER_TOKEN: token })).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.flat().join(' ')).toContain('No job available');
    expect(log.mock.calls.flat().join(' ')).not.toContain(token);
  });

  it('exits 130 without logging secrets when interrupted during a long-poll claim', async () => {
    const token = 'S'.repeat(43);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const shutdown = new AbortController();
    const fetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith('/register')) return Response.json({ ...registration, heartbeatIntervalSeconds: 5 });
      queueMicrotask(() => shutdown.abort(new Error('SIGINT')));
      return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new TypeError('fetch failed')), { once: true }));
    });
    vi.stubGlobal('fetch', fetch);
    const argv = ['--worker-key', 'provisioned-worker', '--wait-seconds', '20'];
    expect(await main(argv, { WORKER_TOKEN: token }, shutdown.signal)).toBe(130);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.flat().join(' ')).toContain('Interrupted');
    expect(log.mock.calls.flat().join(' ')).not.toContain(token);
  });

  it('normalizes the CLI base URL through the same library guard', () => {
    expect(parseArgs(['--worker-key', 'provisioned-worker', '--base-url', 'http://localhost:3000/api/worker/v2/']).baseUrl)
      .toBe('http://localhost:3000/api/worker/v2');
    expect(() => parseArgs(['--worker-key', 'provisioned-worker', '--base-url', 'https://u:p@example.com/'])).toThrow('base-url');
  });

  it('runs a claimed text job with API authentication kept off storage and sanitized output', async () => {
    const token = 'T'.repeat(43);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      if (url.startsWith('https://storage.example/')) {
        expect(headers.has('authorization')).toBe(false);
        expect(init.redirect).toBe('error');
        return new Response(input);
      }
      expect(headers.get('authorization')).toBe(`Bearer ${token}`);
      expect(headers.get('x-contract-version')).toBe('2');
      if (url.endsWith('/register')) return Response.json({ ...registration, heartbeatIntervalSeconds: 5, leaseSeconds: 120 });
      if (url.endsWith('/claim')) return Response.json({ job: textJob('listing_content') });
      expect(url.endsWith('/complete')).toBe(true);
      expect(headers.get('idempotency-key')).toMatch(/^[a-f0-9-]{36}$/);
      const complete = JSON.parse(init.body as string);
      expect(validateContract('ListingContentPayload', complete.payload)).toEqual([]);
      return Response.json({ status: 'succeeded', resultIds: ['result_123'] });
    });
    vi.stubGlobal('fetch', fetch);
    expect(await main(['--worker-key', 'provisioned-worker'], { WORKER_TOKEN: token })).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(4);
    const output = log.mock.calls.flat().join(' ');
    expect(output).toBe('Scenario success: completed; heartbeats=0');
    for (const secret of [token, 'signature=secret', 'test-lease-token-123']) expect(output).not.toContain(secret);
  });

  it('accepts pnpm optional delimiter and documented flags', () => {
    expect(parseArgs(['--', '--base-url', 'http://localhost:3000', '--worker-key', 'provisioned-worker', '--account-key', 'local-account', '--scenario', 'slow']))
      .toMatchObject({ baseUrl: 'http://localhost:3000', workerKey: 'provisioned-worker', accountKey: 'local-account', scenario: 'slow' });
    expect(parseArgs(['--', '--help']).help).toBe(true);
  });
  it('rejects unknown, missing and token flags without reflecting their values', () => {
    expect(() => parseArgs(['--token', 'super-secret'])).toThrow(/^Unknown CLI option$/);
    expect(() => parseArgs(['--scenario', 'not-a-scenario'])).toThrow(/scenario/i);
    expect(() => parseArgs(['--base-url'])).toThrow(/value/i);
    expect(() => parseArgs(['--base-url', '--help'])).toThrow(/value/i);
    expect(() => parseArgs(['--worker-key', 'x', '--worker-key', 'y'])).toThrow(/Duplicate/);
  });
});
