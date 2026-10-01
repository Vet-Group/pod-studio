import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShopifyClient, shopifyEndpoint } from '../../src/shopify/client';
import { startShopifyStub } from '../../../../tests/support/shopify-stub';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllEnvs(); while (cleanups.length) await cleanups.pop()!(); });
const cost = { requestedQueryCost: 10, actualQueryCost: 2, throttleStatus: { maximumAvailable: 100, currentlyAvailable: 0, restoreRate: 5 } };
async function harness(responses: Parameters<typeof startShopifyStub>[0] = []) {
  const stub = await startShopifyStub(responses);
  cleanups.push(stub.close);
  const sleep = vi.fn(async (_ms: number) => {});
  const client = createShopifyClient({ domain: 'demo.myshopify.com', apiVersion: '2026-01', accessToken: 'shpat_no_echo', endpoint: stub.url, environment: 'test', sleep, maxRetries: 2 });
  return { stub, sleep, client };
}

describe('Shopify GraphQL transport', () => {
  it('uses the Admin API endpoint and ignores overrides in production', () => {
    expect(shopifyEndpoint('demo.myshopify.com', '2026-01', 'http://127.0.0.1:1', 'production')).toBe('https://demo.myshopify.com/admin/api/2026-01/graphql.json');
    expect(() => shopifyEndpoint('evil.example', '2026-01')).toThrow();
    expect(() => shopifyEndpoint('demo.myshopify.com', '../bad')).toThrow();
    expect(() => shopifyEndpoint('demo.myshopify.com', '2026-01', 'http://evil.example', 'test')).toThrow();
  });
  it('cannot bypass production endpoint protection through an option', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(shopifyEndpoint('demo.myshopify.com', '2026-01', 'http://127.0.0.1:1', 'test')).toBe('https://demo.myshopify.com/admin/api/2026-01/graphql.json');
  });
  it('waits for cost restoration on THROTTLED then retries', async () => {
    const { client, sleep, stub } = await harness([{ body: { errors: [{ message: 'shpat_no_echo', extensions: { code: 'THROTTLED' } }], extensions: { cost } } }]);
    expect(await client.request('{ shop { name } }')).toEqual({ shop: { name: 'Stub shop', myshopifyDomain: 'demo.myshopify.com' } });
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(stub.requestCount()).toBe(2);
  });
  it('respects cost metadata on HTTP 429 even without Retry-After', async () => {
    const { client, sleep } = await harness([{ status: 429, body: { extensions: { cost } } }]);
    await client.request('{ shop { name } }');
    expect(sleep).toHaveBeenCalledWith(2000);
  });
  it('honors HTTP 429 Retry-After and a bounded retry limit', async () => {
    const { client, sleep, stub } = await harness(Array.from({ length: 3 }, () => ({ status: 429, headers: { 'Retry-After': '1' }, body: { errors: 'shpat_no_echo' } })));
    await expect(client.request('{ shop { name } }')).rejects.toThrow('Shopify request was throttled. Try again later.');
    expect(sleep.mock.calls).toEqual([[1000], [1000]]);
    expect(stub.requestCount()).toBe(3);
  });
  it('uses extensions.cost to pace the next successful request', async () => {
    const { client, sleep } = await harness([{ body: { data: { shop: { name: 'Stub' } }, extensions: { cost } } }]);
    await client.request('{ shop { name } }');
    await client.request('{ shop { name } }');
    expect(sleep).toHaveBeenCalledWith(2000);
  });
  it('fails closed rather than shortening excessive retry delays', async () => {
    const { client, stub, sleep } = await harness([{ status: 429, headers: { 'Retry-After': '3600' } }]);
    await expect(client.request('{ shop { name } }')).rejects.toThrow('Shopify request was throttled. Try again later.');
    expect(stub.requestCount()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
  it.each([401, 500, 200])('does not echo errors or secrets for HTTP %s', async (status) => {
    const { client, stub } = await harness([{ status, body: { errors: [{ message: 'shpat_no_echo' }] } }]);
    const log = vi.spyOn(console, 'error');
    const error = await client.request('{ shop { name } }').catch((error: unknown) => String(error));
    expect(error).not.toContain('shpat_no_echo');
    expect(JSON.stringify(log.mock.calls)).not.toContain('shpat_no_echo');
    expect(stub.requestCount()).toBe(1);
    log.mockRestore();
  });
  it('never forwards credentials across redirects', async () => {
    const { client, stub } = await harness([{ status: 302, headers: { Location: 'http://127.0.0.1:1' } }]);
    await expect(client.request('{ shop { name } }')).rejects.toThrow('Unable to reach Shopify.');
    expect(stub.requestCount()).toBe(1);
  });
});
