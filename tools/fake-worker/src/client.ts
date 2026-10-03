import { validateContract, type ContractSchemaName, type components } from '@pod-studio/contracts';

/** Worker API v2 HTTP client. Talks only to the documented routes; validates both directions. */

export type Schemas = components['schemas'];
export type RegisterRequest = Schemas['RegisterRequest'];
export type RegisterResponse = Schemas['RegisterResponse'];
export type AccountDeclaration = Schemas['AccountDeclaration'];
export type ClaimRequest = Schemas['ClaimRequest'];
export type ClaimedJob = Schemas['ClaimResponse']['job'];
export type HeartbeatRequest = Schemas['HeartbeatRequest'];
export type HeartbeatResponse = Schemas['HeartbeatResponse'];
export type UploadsRequest = Schemas['UploadsRequest'];
export type UploadsResponse = Schemas['UploadsResponse'];
export type UploadTarget = Schemas['UploadTarget'];
export type OutputImage = Schemas['OutputImage'];
export type ProviderMeta = Schemas['ProviderMeta'];
export type CompleteResponse = Schemas['CompleteResponse'];
export type FailRequest = Schemas['FailRequest'];
export type FailResponse = Schemas['FailResponse'];
export type AccountStatusRequest = Schemas['AccountStatusRequest'];
export type AccountStatusResponse = Schemas['AccountStatusResponse'];
export type AssetRef = Schemas['AssetRef'];
export type ErrorClass = Schemas['ErrorClass'];
export type JobType = Schemas['JobType'];
export type Problem = Schemas['Problem'];
/** The generated type collapses `payload` to `Record<string, never>`; the JSON Schema allows an object. */
export type CompleteRequest =
  | { leaseToken: string; images: OutputImage[]; providerMeta?: ProviderMeta }
  | { leaseToken: string; payload: Record<string, unknown>; providerMeta?: ProviderMeta };

export const CONTRACT_VERSION = '2';

/** A non-2xx answer from the Worker API, carrying the RFC 9457 problem `code`. */
export class WorkerApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly problem?: Problem,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Worker API answered ${status} ${code}${problem?.detail && problem.detail !== code ? `: ${problem.detail}` : ''}`);
    this.name = 'WorkerApiProblem';
  }
}

/** A request or response that does not match the checked-in contract. */
export class ContractViolation extends Error {
  constructor(readonly schema: string, readonly errors: Array<{ path: string; message: string }>) {
    super(`${schema} does not match the worker contract: ${errors.map((error) => `${error.path || '/'} ${error.message}`).join('; ')}`);
    this.name = 'ContractViolation';
  }
}

export const isProblem = (error: unknown, code?: string): error is WorkerApiProblem =>
  error instanceof WorkerApiProblem && (code === undefined || error.code === code);

export function assertShape(schema: ContractSchemaName, value: unknown): void {
  const errors = validateContract(schema, value);
  if (errors.length) throw new ContractViolation(schema, errors);
}

export interface WorkerClientOptions {
  /** Base URL of the Worker API, for example `http://localhost:3000/api/worker/v2`. */
  baseUrl: string;
  /** Per-worker bearer token issued by an admin. */
  token: string;
  fetch?: typeof fetch;
  /** Per-request timeout for everything except long-poll claims. */
  timeoutMs?: number;
  /** Extra attempts for idempotent calls (heartbeat, complete, fail) on network errors, 5xx and 429. */
  retries?: number;
  retryBaseDelayMs?: number;
}

interface PostOptions {
  idempotencyKey?: string;
  allowEmpty?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  retry?: boolean;
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(signal?.reason); };
  signal?.addEventListener('abort', abort, { once: true });
});

export class WorkerClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: WorkerClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    if (typeof options.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(options.token)) {
      throw new Error('The worker token must be the 43-character token issued by an admin.');
    }
    if (options.timeoutMs !== undefined && !isTimerMs(options.timeoutMs, 1)) throw new Error('timeoutMs must be a positive timer-safe integer.');
    if (options.retries !== undefined && (!Number.isSafeInteger(options.retries) || options.retries < 0 || options.retries > 10)) {
      throw new Error('retries must be an integer from 0 to 10.');
    }
    if (options.retryBaseDelayMs !== undefined && !isTimerMs(options.retryBaseDelayMs, 0)) {
      throw new Error('retryBaseDelayMs must be a non-negative timer-safe integer.');
    }
    if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new Error('fetch must be a function.');
    this.fetchImpl = options.fetch ?? fetch;
  }

  register(body: RegisterRequest): Promise<RegisterResponse> {
    return this.post('/register', 'RegisterRequest', body, 'RegisterResponse') as Promise<RegisterResponse>;
  }

  /** Long-polls for one job. Resolves `null` on 204 (nothing to do within `waitSeconds`). */
  async claim(body: ClaimRequest, signal?: AbortSignal): Promise<ClaimedJob | null> {
    const timeoutMs = (body.waitSeconds + 15) * 1000;
    const response = await this.post('/claim', 'ClaimRequest', body, 'ClaimResponse', { allowEmpty: true, signal, timeoutMs });
    return response ? (response as Schemas['ClaimResponse']).job : null;
  }

  /** Aborting `signal` cancels the in-flight request and any retry backoff. */
  heartbeat(jobId: string, body: HeartbeatRequest, signal?: AbortSignal): Promise<HeartbeatResponse> {
    return this.post(`/jobs/${encodeURIComponent(jobId)}/heartbeat`, 'HeartbeatRequest', body, 'HeartbeatResponse', { retry: true, signal }) as Promise<HeartbeatResponse>;
  }

  uploads(jobId: string, body: UploadsRequest, signal?: AbortSignal): Promise<UploadsResponse> {
    return this.post(`/jobs/${encodeURIComponent(jobId)}/uploads`, 'UploadsRequest', body, 'UploadsResponse', { signal }) as Promise<UploadsResponse>;
  }

  complete(jobId: string, body: CompleteRequest, idempotencyKey: string, signal?: AbortSignal): Promise<CompleteResponse> {
    return this.post(`/jobs/${encodeURIComponent(jobId)}/complete`, 'CompleteRequest', body, 'CompleteResponse', { idempotencyKey, retry: true, signal }) as Promise<CompleteResponse>;
  }

  fail(jobId: string, body: FailRequest, idempotencyKey: string, signal?: AbortSignal): Promise<FailResponse> {
    return this.post(`/jobs/${encodeURIComponent(jobId)}/fail`, 'FailRequest', body, 'FailResponse', { idempotencyKey, retry: true, signal }) as Promise<FailResponse>;
  }

  accountStatus(accountId: string, body: AccountStatusRequest): Promise<AccountStatusResponse> {
    return this.post(`/accounts/${encodeURIComponent(accountId)}/status`, 'AccountStatusRequest', body, 'AccountStatusResponse') as Promise<AccountStatusResponse>;
  }

  private async post(path: string, requestSchema: ContractSchemaName, body: unknown, responseSchema: ContractSchemaName, options: PostOptions = {}): Promise<unknown> {
    assertShape(requestSchema, body);
    if (options.idempotencyKey !== undefined && (options.idempotencyKey.length < 8 || options.idempotencyKey.length > 128)) {
      throw new Error('Idempotency-Key must be 8 to 128 characters.');
    }
    const attempts = options.retry ? 1 + (this.options.retries ?? 2) : 1;
    for (let attempt = 1; ; attempt++) {
      options.signal?.throwIfAborted();
      try {
        return await this.send(path, body, responseSchema, options);
      } catch (error) {
        // A caller abort surfaces as its own reason, never as a retryable network error.
        options.signal?.throwIfAborted();
        const retryable = attempt < attempts && isRetryable(error);
        if (!retryable) throw error;
        const base = this.options.retryBaseDelayMs ?? 250;
        const hinted = error instanceof WorkerApiProblem && error.retryAfterSeconds !== undefined ? error.retryAfterSeconds * 1000 : 0;
        await sleep(Math.max(hinted, base * 2 ** (attempt - 1)), options.signal);
      }
    }
  }

  private async send(path: string, body: unknown, responseSchema: ContractSchemaName, options: PostOptions): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.token}`,
      'content-type': 'application/json',
      accept: 'application/json, application/problem+json',
      'x-contract-version': CONTRACT_VERSION,
    };
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.options.timeoutMs ?? 30_000);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' });
    if (response.status === 204 && options.allowEmpty) return null;
    const text = await response.text();
    let data: unknown;
    try { data = text ? JSON.parse(text) : undefined; }
    catch { throw new WorkerApiProblem(response.status, response.ok ? 'invalid_json' : `http_${response.status}`); }
    if (!response.ok) {
      const problem = validateContract('Problem', data).length === 0 ? data as Problem : undefined;
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new WorkerApiProblem(response.status, problem?.code ?? `http_${response.status}`, problem, Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined);
    }
    assertShape(responseSchema, data);
    return data;
  }
}

const isTimerMs = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= 2_147_483_647;

/**
 * Validate and normalize the Worker API base URL at the library boundary so every consumer, not just the CLI,
 * gets the same guard. Errors never echo the input: a malformed URL may carry credentials.
 */
export function normalizeBaseUrl(baseUrl: unknown): string {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') throw new Error('The Worker API base URL is required.');
  let url: URL;
  try { url = new URL(baseUrl.trim()); }
  catch { throw new Error('The Worker API base URL must be an absolute http(s) URL.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The Worker API base URL must be http(s).');
  if (url.username || url.password) throw new Error('The Worker API base URL must not contain credentials; pass the token separately.');
  if (url.search || url.hash) throw new Error('The Worker API base URL must not contain a query string or fragment.');
  // URL parsing silently resolves `..`, `%2e%2e` and `\` into a different path, so inspect the raw path as typed.
  const rawPath = baseUrl.trim().replace(/^[a-z][a-z0-9+.-]*:[/\\]{2}[^/\\?#]*/i, '').replace(/[/\\]+$/, '');
  const segments = rawPath.split(/[/\\]/).slice(1);
  if (rawPath.includes('\\') || /%(?:2f|5c)/i.test(rawPath) || segments.some((s) => s === '' || /^(?:\.|%2e){1,2}$/i.test(s))) {
    throw new Error('The Worker API base URL path must not contain dot segments, encoded separators, backslashes or empty segments.');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof WorkerApiProblem) return error.status === 429 || error.status >= 500;
  if (error instanceof ContractViolation) return false;
  // fetch network failures surface as TypeError; per-request timeouts as TimeoutError.
  return error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError');
}
