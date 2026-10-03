import { describe, expect, it, vi } from 'vitest';
import { ContractViolation, WorkerApiProblem, WorkerClient } from '../src/client';

const token = 'a'.repeat(43);
const baseUrl = 'http://127.0.0.1:3000/api/worker/v2';
const claim = { workerId: 'worker_123', accountId: 'account_123', waitSeconds: 0 };
const problem = (status: number, code: string) => Response.json({ type: 'about:blank', title: code, status, code }, { status, headers: { 'retry-after': '0' } });
function client(transport: typeof fetch) {
  return new WorkerClient({ baseUrl, token, fetch: transport, retries: 1, retryBaseDelayMs: 0 });
}

describe('WorkerClient transport', () => {
  it('returns null for a real empty-queue response and sends the required headers', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    expect(await client(transport).claim(claim)).toBeNull();
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/claim`);
    expect(init!.headers).toMatchObject({ authorization: `Bearer ${token}`, 'x-contract-version': '2', 'content-type': 'application/json' });
    expect(init!.redirect).toBe('error');
  });

  it('rejects a malformed request before any network call', async () => {
    const transport = vi.fn<typeof fetch>();
    await expect(client(transport).claim({ ...claim, waitSeconds: -1 })).rejects.toBeInstanceOf(ContractViolation);
    expect(transport).not.toHaveBeenCalled();
  });

  it('validates successful responses instead of treating any 200 as success', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ bogus: true }));
    await expect(client(transport).claim(claim)).rejects.toBeInstanceOf(ContractViolation);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([429, 503])('retries idempotent heartbeat after HTTP %s', async (status) => {
    const body = { leaseExpiresAt: '2099-01-01T00:00:00Z', cancelRequested: false };
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(problem(status, 'rate_limited')).mockResolvedValueOnce(Response.json(body));
    expect(await client(transport).heartbeat('job_12345', { leaseToken: 'test-lease' })).toEqual(body);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('does not retry claim because a lost response may already have acquired a lease', async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('network error'));
    await expect(client(transport).claim(claim)).rejects.toThrow('network error');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('keeps the same idempotency key and body when retrying complete', async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('lost response')).mockResolvedValueOnce(Response.json({ status: 'succeeded', resultIds: [] }));
    await client(transport).complete('job_12345', { leaseToken: 'test-lease', payload: { title: 'test' } }, 'test-complete-key');
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[0]![1]!.body).toBe(transport.mock.calls[1]![1]!.body);
    for (const [, init] of transport.mock.calls) expect(init!.headers).toMatchObject({ 'idempotency-key': 'test-complete-key' });
  });

  it('does not retry lease loss', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(problem(409, 'lease_lost'));
    await expect(client(transport).heartbeat('job_12345', { leaseToken: 'test-lease' })).rejects.toMatchObject({ status: 409, code: 'lease_lost' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('reports malformed JSON without leaking the response body', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('private upstream diagnostics', { status: 200 }));
    await expect(client(transport).claim(claim)).rejects.toMatchObject({ code: 'invalid_json' });
  });

  it('rejects unsafe API schemes and malformed tokens', () => {
    expect(() => new WorkerClient({ baseUrl: 'file:///private', token })).toThrow('http(s)');
    expect(() => new WorkerClient({ baseUrl, token: 'wrong' })).toThrow('43-character');
    expect(new WorkerApiProblem(409, 'lease_lost').code).toBe('lease_lost');
  });
});

describe('WorkerClient base URL at the library boundary', () => {
  it.each([
    ['missing', undefined, 'required'],
    ['empty', '', 'required'],
    ['blank', '   ', 'required'],
    ['non-string', 42, 'required'],
    ['relative', '/api/worker/v2', 'absolute http(s)'],
    ['host-less', 'localhost:3000', 'http(s)'],
    ['javascript scheme', 'javascript:alert(1)', 'http(s)'],
    ['embedded credentials', 'https://user:p4ss@example.com/api/worker/v2', 'credentials'],
    ['query string', 'https://example.com/api/worker/v2?token=x', 'query string or fragment'],
    ['fragment', 'https://example.com/api/worker/v2#frag', 'query string or fragment'],
    ['dot-segment', 'https://example.com/api/../admin/v2', 'dot segments'],
    ['current-dir segment', 'https://example.com/api/./worker/v2', 'dot segments'],
    ['trailing dot-segment', 'https://example.com/api/worker/v2/..', 'dot segments'],
    ['percent-encoded dot-segment', 'https://example.com/api/%2e%2E/v2', 'dot segments'],
    ['encoded slash', 'https://example.com/api%2Fworker/v2', 'encoded separators'],
    ['encoded backslash', 'https://example.com/api%5cworker/v2', 'encoded separators'],
    ['backslash', 'https://example.com/api\\worker\\v2', 'backslashes'],
    ['empty-segment', 'https://example.com/api//worker/v2', 'empty segments'],
  ])('rejects a %s base URL without echoing it', (_label, value, message) => {
    const create = () => new WorkerClient({ baseUrl: value as string, token });
    expect(create).toThrow(message);
    try { create(); } catch (error) {
      if (typeof value === 'string' && value.trim()) expect((error as Error).message).not.toContain(value.trim());
    }
  });

  it('normalizes trailing slashes and surrounding whitespace before any request', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await new WorkerClient({ baseUrl: `  ${baseUrl}///  `, token, fetch: transport }).claim(claim);
    expect(transport.mock.calls[0]![0]).toBe(`${baseUrl}/claim`);
  });

  it('rejects invalid transport options before any request', () => {
    expect(() => new WorkerClient({ baseUrl, token, timeoutMs: 0 })).toThrow('timeoutMs');
    expect(() => new WorkerClient({ baseUrl, token, retries: -1 })).toThrow('retries');
    expect(() => new WorkerClient({ baseUrl, token, retries: 1.5 })).toThrow('retries');
    expect(() => new WorkerClient({ baseUrl, token, retryBaseDelayMs: Number.NaN })).toThrow('retryBaseDelayMs');
    expect(() => new WorkerClient({ baseUrl, token, fetch: 'nope' as unknown as typeof fetch })).toThrow('fetch');
  });
});

describe('WorkerClient cancellation', () => {
  const heartbeatBody = { leaseExpiresAt: '2099-01-01T00:00:00Z', cancelRequested: false };

  it('aborting during retry backoff stops further attempts with the abort reason', async () => {
    vi.useFakeTimers();
    try {
      const transport = vi.fn<typeof fetch>().mockImplementation(async () => problem(503, 'unavailable'));
      const worker = new WorkerClient({ baseUrl, token, fetch: transport, retries: 5, retryBaseDelayMs: 1000 });
      const controller = new AbortController();
      const call = worker.heartbeat('job_1', { leaseToken: 'lease' }, controller.signal);
      const settled = expect(call).rejects.toThrow('shutdown');
      await vi.advanceTimersByTimeAsync(10);
      expect(transport).toHaveBeenCalledTimes(1); // Now sleeping in backoff.
      controller.abort(new Error('shutdown'));
      await settled;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(transport).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('aborting an in-flight request is not retried as a network error', async () => {
    const controller = new AbortController();
    const transport = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new TypeError('fetch failed')), { once: true });
    }));
    const call = new WorkerClient({ baseUrl, token, fetch: transport, retries: 3, retryBaseDelayMs: 0 })
      .heartbeat('job_1', { leaseToken: 'lease' }, controller.signal);
    controller.abort(new Error('shutdown'));
    await expect(call).rejects.toThrow('shutdown');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('an already-aborted signal makes no request', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(heartbeatBody));
    await expect(client(transport).heartbeat('job_1', { leaseToken: 'lease' }, AbortSignal.abort(new Error('gone')))).rejects.toThrow('gone');
    expect(transport).not.toHaveBeenCalled();
  });

  it('a non-retried call aborted in flight rejects with the abort reason, not the transport error', async () => {
    const controller = new AbortController();
    const transport = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new TypeError('fetch failed')), { once: true });
    }));
    const files = [{ contentType: 'image/png' as const, bytes: 10, sha256: 'a'.repeat(64) }];
    const call = client(transport).uploads('job_1', { leaseToken: 'lease-token-123', files }, controller.signal);
    controller.abort(new Error('shutdown'));
    await expect(call).rejects.toThrow('shutdown');
  });
});
