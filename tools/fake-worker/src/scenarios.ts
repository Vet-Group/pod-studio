import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createDeflate } from 'node:zlib';
import { validateContract, type ContractSchemaName } from '@pod-studio/contracts';
import type { ClaimedJob, CompleteRequest, OutputImage, RegisterResponse, WorkerClient } from './client';

export const scenarios = ['success', 'slow', 'rate_limit', 'expired_session', 'lease_timeout', 'checksum_mismatch'] as const;
export type Scenario = typeof scenarios[number];
export interface ScenarioOptions {
  slowDurationMs?: number;
  heartbeatIntervalMs?: number;
  /** Compressed output bytes generated before they are declared and uploaded (default 64 MiB). */
  maxStagedBytes?: number;
  /**
   * Local shutdown, for example SIGINT. Aborting stops heartbeats, their retry backoff and storage I/O and skips
   * complete/fail; the run resolves `abandoned` and the server reaper owns the lease. An in-flight complete or
   * fail is not interrupted, so a final write that already started still reports its real outcome.
   */
  signal?: AbortSignal;
}
export interface ScenarioResult { outcome: 'completed' | 'failed' | 'abandoned' | 'rejected'; heartbeatCount: number }

const storageTimeoutMs = 30_000;
const rawBlockBytes = 4 * 1024 * 1024;
const defaultMaxStagedBytes = 64 * 1024 * 1024;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const hasCode = (error: unknown, code: string) => typeof error === 'object' && error !== null && 'code' in error && error.code === code;

function assertContract(schema: ContractSchemaName, value: unknown): void {
  if (validateContract(schema, value).length) throw new Error(`Generated ${schema} does not match the worker contract`);
}

/** Storage requests never reuse the authenticated WorkerClient transport. */
function storageUrl(raw: string, origins: string[]): URL {
  try {
    const url = new URL(raw);
    const allowed = origins.map((origin) => {
      const parsed = new URL(origin);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
        throw new Error('Invalid origin');
      }
      return parsed.origin;
    });
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || !allowed.includes(url.origin)) {
      throw new Error('Disallowed URL');
    }
    return url;
  } catch {
    // Do not include a presigned URL or userinfo in errors, even for malformed URLs.
    throw new Error('Unsafe storage URL: expected an allowlisted http(s) origin without credentials');
  }
}

async function storageRequest(url: URL, operation: 'download' | 'upload', init: RequestInit, signal: AbortSignal): Promise<Response> {
  try {
    const response = await fetch(url.href, {
      ...init, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
      signal: AbortSignal.any([signal, AbortSignal.timeout(storageTimeoutMs)]),
    });
    if (!response.ok || response.redirected) {
      await response.body?.cancel();
      throw new Error('Storage response rejected');
    }
    return response;
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new Error(`Storage ${operation} failed`);
  }
}

async function verifyInputs(job: ClaimedJob, origins: string[], signal: AbortSignal): Promise<void> {
  // Validate the entire batch before the first request (including inputs never used by synthetic output).
  const urls = job.inputs.map((input) => storageUrl(input.url, origins));
  for (let i = 0; i < job.inputs.length; i++) {
    signal.throwIfAborted();
    const input = job.inputs[i]!;
    const response = await storageRequest(urls[i]!, 'download', { method: 'GET' }, signal);
    const hash = createHash('sha256');
    const reader = response.body?.getReader();
    let size = 0;
    try {
      if (reader) {
        for (;;) {
          signal.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > input.bytes) throw new Error('Input size mismatch');
          hash.update(value);
        }
      }
    } catch (error) {
      await reader?.cancel().catch(() => {});
      if (signal.aborted) throw signal.reason;
      if (error instanceof Error && error.message === 'Input size mismatch') throw error;
      throw new Error('Storage download failed');
    } finally {
      reader?.releaseLock();
    }
    if (size !== input.bytes) throw new Error('Input size mismatch');
    if (hash.digest('hex') !== input.sha256) throw new Error('Input checksum mismatch');
  }
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  output.write(type, 4, 4, 'ascii');
  data.copy(output, 8);
  output.writeUInt32BE(crc32(output.subarray(4, data.length + 8)), data.length + 8);
  return output;
}

/**
 * A real RGB PNG with unfiltered rows, zlib-compressed IDAT and CRC-protected chunks.
 *
 * Rows stream through an async deflate in blocks of about `rawBlockBytes`, so memory stays bounded by
 * one block plus the compressed output instead of the full raw frame (about 192 MiB at 8192x8192),
 * and the event loop stays free for heartbeats and cancellation while the image is compressed.
 */
async function png(width: number, height: number, index: number, signal: AbortSignal): Promise<Buffer<ArrayBuffer>> {
  const stride = width * 3 + 1;
  const row = Buffer.alloc(stride);
  for (let x = 0; x < width; x++) {
    row[x * 3 + 1] = (48 + index * 29) % 256;
    row[x * 3 + 2] = (120 + index * 17) % 256;
    row[x * 3 + 3] = (176 + index * 37) % 256;
  }
  const rowsPerBlock = Math.max(1, Math.min(height, Math.floor(rawBlockBytes / stride)));
  const block = Buffer.alloc(stride * rowsPerBlock);
  for (let y = 0; y < rowsPerBlock; y++) row.copy(block, y * stride);
  const compressed: Buffer[] = [];
  try {
    await pipeline(
      function* rows() {
        for (let y = 0; y < height; y += rowsPerBlock) yield block.subarray(0, Math.min(rowsPerBlock, height - y) * stride);
      },
      createDeflate(),
      async function collect(source: AsyncIterable<Buffer>) { for await (const part of source) compressed.push(part); },
      { signal },
    );
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB, no interlacing
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', Buffer.concat(compressed)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

interface StagedImage { body: Buffer<ArrayBuffer>; declaration: { contentType: 'image/png'; bytes: number; sha256: string } }

/**
 * Generate, declare and upload images in batches so staged output stays bounded: a batch is flushed once
 * its compressed bytes reach `maxStagedBytes`, so at most that budget plus one image is held at a time.
 * The Worker API accepts repeated `/uploads` calls up to 20 targets per job.
 */
async function imageOutput(
  client: WorkerClient, job: ClaimedJob & { type: 'mockup' | 'redesign' }, origins: string[], signal: AbortSignal, maxStagedBytes: number,
): Promise<OutputImage[]> {
  const [rw, rh] = job.params.ratio.split(':').map(Number) as [number, number];
  const multiplier = Math.ceil((job.params.minLongEdge ?? 512) / Math.max(rw, rh));
  const width = rw * multiplier, height = rh * multiplier;
  const images: OutputImage[] = [];
  let batch: StagedImage[] = [];
  let stagedBytes = 0;
  for (let index = 0; index < job.params.count; index++) {
    signal.throwIfAborted();
    const body = await png(width, height, index, signal);
    batch.push({ body, declaration: { contentType: 'image/png', bytes: body.length, sha256: sha256(body) } });
    stagedBytes += body.length;
    if (stagedBytes >= maxStagedBytes || index === job.params.count - 1) {
      images.push(...await uploadBatch(client, job, batch, origins, signal, width, height));
      batch = [];
      stagedBytes = 0;
    }
  }
  return images;
}

async function uploadBatch(
  client: WorkerClient, job: ClaimedJob, files: StagedImage[], origins: string[], signal: AbortSignal, width: number, height: number,
): Promise<OutputImage[]> {
  signal.throwIfAborted();
  const request = { leaseToken: job.leaseToken, files: files.map((file) => file.declaration) };
  assertContract('UploadsRequest', request);
  const { uploads } = await client.uploads(job.id, request, signal);
  signal.throwIfAborted();
  if (uploads.length !== files.length) throw new Error('Expected one upload target per declared image');
  // Check all targets before starting PUTs. Honor required signed headers but never forward auth.
  const targets = uploads.map((target) => {
    const url = storageUrl(target.url, origins);
    const headers = new Headers(target.headers);
    if (headers.has('authorization') || headers.has('proxy-authorization') || headers.has('cookie')) {
      throw new Error('Storage authorization or cookie headers are not allowed');
    }
    if (target.method !== 'PUT') throw new Error('Storage upload target must use PUT');
    return { url, headers };
  });
  const images: OutputImage[] = [];
  for (let i = 0; i < files.length; i++) {
    signal.throwIfAborted();
    const file = files[i]!, target = targets[i]!;
    const response = await storageRequest(target.url, 'upload', { method: 'PUT', headers: target.headers, body: file.body }, signal);
    await response.body?.cancel();
    images.push({ uploadKey: uploads[i]!.uploadKey, ...file.declaration, width, height });
  }
  return images;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function textOutput(job: ClaimedJob & { type: 'listing_content' | 'product_analysis' }): Record<string, unknown> {
  const niche = job.params.niche || 'original artwork';
  const product = job.params.productType || 'print';
  if (job.type === 'listing_content') {
    const taken = new Set((job.params.takenKeywords ?? []).map((keyword) => keyword.trim().toLowerCase()));
    const base = `${niche} ${product}`.slice(0, 60);
    let primaryKeyword = base;
    for (let i = 1; taken.has(primaryKeyword.toLowerCase()); i++) primaryKeyword = `${base} ${i}`;
    const title = `${niche} ${product} - synthetic sample`;
    const handle = `${niche}-${product}-${job.id}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 200) || 'sample-listing';
    const payload = {
      title, artworkName: 'Synthetic sample', primaryKeyword,
      description: `<p>Synthetic ${escapeHtml(product)} listing for ${escapeHtml(niche)}. Generated by the fake worker for testing.</p>`,
      tags: [primaryKeyword], seoTitle: title.slice(0, 200),
      seoDescription: `A synthetic ${product} sample for ${niche}.`, urlHandle: handle, locale: job.params.locale,
    };
    assertContract('ListingContentPayload', payload);
    return payload;
  }
  const payload = {
    summary: `Synthetic analysis of ${product} for ${niche}; not a real provider assessment.`,
    audiences: [{ name: `${niche} enthusiasts`.slice(0, 120), why: 'Sample audience for deterministic contract tests.' }],
    keywords: { primary: [niche.slice(0, 120)], secondary: [product] },
    suggestedProductTypes: [product], locale: job.params.locale,
  };
  assertContract('ProductAnalysisPayload', payload);
  return payload;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Serialized heartbeats run through slow work, including storage I/O.
 *
 * `drain()` stops scheduling and lets an in-flight heartbeat, including its retries, report a late cancel before
 * the final write. `stop()` also aborts that call and any retry backoff, so error paths and local shutdown never
 * wait for a heartbeat that can no longer change the outcome.
 */
function monitor(client: WorkerClient, job: ClaimedJob, interval: number, work: AbortController, count: () => void, shutdown?: AbortSignal) {
  const scheduling = new AbortController();
  const halt = new AbortController();
  const calls = shutdown ? AbortSignal.any([halt.signal, shutdown]) : halt.signal;
  const ticks = AbortSignal.any([scheduling.signal, calls]);
  let reason: 'cancelled' | 'lease_lost' | undefined;
  let failure: unknown;
  const running = (async () => {
    let nextHeartbeatAt = Date.now() + interval;
    while (!ticks.aborted) {
      try { await sleep(Math.max(0, nextHeartbeatAt - Date.now()), ticks); }
      catch { break; }
      // Schedule from the call's start, not its response; skip missed ticks without overlapping calls.
      nextHeartbeatAt = Date.now() + interval;
      try {
        count();
        const response = await client.heartbeat(job.id, { leaseToken: job.leaseToken }, calls);
        if (response.cancelRequested) {
          reason = 'cancelled'; work.abort(new Error('Job cancellation requested')); break;
        }
      } catch (error) {
        if (calls.aborted) break; // Our own stop or local shutdown, not a heartbeat failure.
        if (hasCode(error, 'lease_lost')) reason = 'lease_lost';
        else failure = error;
        work.abort(new Error('Heartbeat failed')); break;
      }
    }
  })();
  return {
    async drain() { scheduling.abort(); await running; },
    async stop() { scheduling.abort(); halt.abort(); await running; },
    get reason() { return reason; },
    get failure() { return failure; },
  };
}

/** Execute one claimed job through only the public Worker API and presigned storage URLs. */
export async function runScenario(
  client: WorkerClient, job: ClaimedJob, registration: RegisterResponse, scenario: Scenario,
  options: ScenarioOptions = {},
): Promise<ScenarioResult> {
  let heartbeatCount = 0;
  const result = (outcome: ScenarioResult['outcome']): ScenarioResult => ({ outcome, heartbeatCount });
  const shutdown = options.signal;
  if (!scenarios.includes(scenario)) throw new Error('Unknown fake-worker scenario');
  const maxStagedBytes = options.maxStagedBytes ?? defaultMaxStagedBytes;
  if (!Number.isSafeInteger(maxStagedBytes) || maxStagedBytes <= 0) throw new Error('maxStagedBytes must be a positive safe integer');
  if (scenario === 'lease_timeout' || shutdown?.aborted) return result('abandoned'); // The real server reaper owns expiry/retry.
  if (scenario === 'checksum_mismatch' && (job.type === 'listing_content' || job.type === 'product_analysis')) {
    throw new Error('checksum_mismatch is unsupported for text jobs; no output image checksum exists');
  }
  if (scenario === 'rate_limit' || scenario === 'expired_session') {
    try {
      await client.fail(job.id, {
        leaseToken: job.leaseToken,
        errorClass: scenario === 'rate_limit' ? 'account_rate_limited' : 'account_session_expired',
        message: scenario === 'rate_limit' ? 'Simulated provider account rate limit' : 'Simulated provider account session expiry',
        ...(scenario === 'rate_limit' ? { retryAfterSeconds: 60 } : {}),
      }, randomUUID());
      return result('failed');
    } catch (error) {
      if (hasCode(error, 'lease_lost')) return result('abandoned');
      throw error;
    }
  }

  const interval = options.heartbeatIntervalMs ?? registration.heartbeatIntervalSeconds * 1000;
  const duration = options.slowDurationMs ?? interval * 3;
  if (scenario === 'slow') {
    if (!Number.isSafeInteger(interval) || interval <= 0 || interval > 2_147_483_647) throw new Error('heartbeatIntervalMs must be a positive timer-safe integer');
    if (!Number.isSafeInteger(duration) || duration < 0 || duration > 2_147_483_647) throw new Error('slowDurationMs must be a non-negative timer-safe integer');
  }
  const work = new AbortController();
  const onShutdown = () => work.abort(shutdown!.reason);
  shutdown?.addEventListener('abort', onShutdown, { once: true });
  const heartbeat = scenario === 'slow' ? monitor(client, job, interval, work, () => { heartbeatCount++; }, shutdown) : undefined;
  let finalWriteStarted = false;
  try {
    if (scenario === 'slow') await sleep(duration, work.signal);
    await verifyInputs(job, registration.storageOrigins, work.signal);
    const completion: CompleteRequest = job.type === 'mockup' || job.type === 'redesign'
      ? { leaseToken: job.leaseToken, images: await imageOutput(client, job, registration.storageOrigins, work.signal, maxStagedBytes) }
      : { leaseToken: job.leaseToken, payload: textOutput(job) };
    // Drain an outstanding heartbeat before the final write so a late cancel cannot be ignored.
    await heartbeat?.drain();
    work.signal.throwIfAborted();
    if (scenario === 'checksum_mismatch' && 'images' in completion) {
      const image = completion.images[0]!;
      image.sha256 = `${image.sha256[0] === '0' ? '1' : '0'}${image.sha256.slice(1)}`;
    }
    assertContract('CompleteRequest', completion);
    finalWriteStarted = true;
    try { await client.complete(job.id, completion, randomUUID()); }
    catch (error) {
      if (scenario === 'checksum_mismatch' && hasCode(error, 'checksum_mismatch')) return result('rejected');
      throw error;
    }
    if (scenario === 'checksum_mismatch') throw new Error('Server accepted the checksum mismatch; expected checksum_mismatch rejection');
    return result('completed');
  } catch (error) {
    // Settle the monitor first so its reason is final; this aborts a heartbeat still retrying in the background.
    await heartbeat?.stop();
    if (shutdown?.aborted && !finalWriteStarted) return result('abandoned');
    if (heartbeat?.reason === 'cancelled') {
      try {
        await client.fail(job.id, { leaseToken: job.leaseToken, errorClass: 'cancelled', message: 'Acknowledged server cancellation' }, randomUUID());
        return result('failed');
      } catch (failure) {
        if (hasCode(failure, 'lease_lost')) return result('abandoned');
        throw failure;
      }
    }
    if (heartbeat?.reason === 'lease_lost' || hasCode(error, 'lease_lost')) return result('abandoned');
    throw heartbeat?.failure ?? error;
  } finally {
    shutdown?.removeEventListener('abort', onShutdown);
    await heartbeat?.stop();
  }
}
