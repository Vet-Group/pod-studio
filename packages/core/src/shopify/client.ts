import { setTimeout as sleep } from 'node:timers/promises';

export interface ShopifyClientOptions {
  domain: string;
  apiVersion: string;
  accessToken: string;
  /** Local loopback endpoint only, and only in development/test. Ignored in production. */
  endpoint?: string;
  environment?: string;
  maxRetries?: number;
  sleep?: (milliseconds: number) => Promise<unknown>;
}

export function shopifyEndpoint(domain: string, apiVersion: string, override = process.env.SHOPIFY_ENDPOINT_OVERRIDE, environment: string | undefined = process.env.NODE_ENV): string {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain) || !/^20\d{2}-(01|04|07|10)$/.test(apiVersion)) {
    throw new Error('Invalid Shopify store configuration.');
  }
  if (process.env.NODE_ENV !== 'production' && override && (environment === 'test' || environment === 'development')) {
    try {
      const url = new URL(override);
      if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error();
      return url.toString();
    } catch { throw new Error('Invalid Shopify test endpoint.'); }
  }
  return `https://${domain}/admin/api/${apiVersion}/graphql.json`;
}

interface GraphQLResult<T> {
  data?: T;
  errors?: Array<{ extensions?: { code?: string } }>;
  extensions?: { cost?: { requestedQueryCost?: number; throttleStatus?: { currentlyAvailable?: number; restoreRate?: number } } };
}
const MAX_WAIT = 10000;
const throttledError = () => new Error('Shopify request was throttled. Try again later.');

/** No upstream bodies, headers or fetch errors are included in errors/logs. Redirects never carry tokens. */
export function createShopifyClient(options: ShopifyClientOptions) {
  const endpoint = shopifyEndpoint(options.domain, options.apiVersion, options.endpoint, options.environment);
  const wait = options.sleep ?? sleep;
  const maxRetries = options.maxRetries ?? 3;
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5 || !options.accessToken || /[\r\n]/.test(options.accessToken)) throw new Error('Invalid Shopify client configuration.');
  let nextDelay = 0;
  async function boundedWait(delay: number) {
    if (!Number.isFinite(delay) || delay > MAX_WAIT) throw throttledError();
    if (delay > 0) await wait(Math.ceil(delay));
  }
  function costDelay(body: GraphQLResult<unknown>): number {
    const cost = body.extensions?.cost;
    const requested = cost?.requestedQueryCost;
    const available = cost?.throttleStatus?.currentlyAvailable;
    const rate = cost?.throttleStatus?.restoreRate;
    if (typeof requested !== 'number' || typeof available !== 'number' || !Number.isFinite(requested) || !Number.isFinite(available)) return 0;
    if (requested <= available) return 0;
    if (typeof rate !== 'number' || rate <= 0 || !Number.isFinite(rate)) return Infinity;
    return Math.max(0, (requested - available) / rate * 1000);
  }
  return {
    async request<T = Record<string, unknown>>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
      await boundedWait(nextDelay);
      nextDelay = 0;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let response: Response;
        let body: GraphQLResult<T> = {};
        try {
          response = await fetch(endpoint, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': options.accessToken, 'X-Shopify-Shop-Domain': options.domain },
            body: JSON.stringify({ query, variables }),
          });
          // 429 may have an empty/non-JSON body. Other malformed responses fail closed.
          if (response.status === 429) {
            try { body = await response.json() as GraphQLResult<T>; } catch { body = {}; }
            if (!body || typeof body !== 'object') body = {};
          } else body = await response.json() as GraphQLResult<T>;
          if (!body || typeof body !== 'object' || (response.status !== 429 && body.errors !== undefined && !Array.isArray(body.errors))) throw new Error();
        } catch { throw new Error('Unable to reach Shopify.'); }
        const isThrottled = response.status === 429 || (response.ok && body.errors?.some((error) => error?.extensions?.code === 'THROTTLED'));
        if (isThrottled) {
          if (attempt === maxRetries) throw throttledError();
          const retryAfter = response.headers.get('Retry-After');
          const headerDelay = retryAfter === null ? 0 : /^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
          await boundedWait(Math.max(Number.isNaN(headerDelay) ? 0 : headerDelay, costDelay(body), 250 * 2 ** attempt));
          continue;
        }
        if (!response.ok || body.errors?.length || body.data === undefined || body.data === null) throw new Error('Shopify rejected the request. Check the credentials and app permissions.');
        nextDelay = costDelay(body);
        return body.data;
      }
      throw throttledError();
    },
  };
}
