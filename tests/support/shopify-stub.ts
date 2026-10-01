import { createServer } from 'node:http';

export interface StubResponse { status?: number; headers?: Record<string, string>; body?: unknown }
/** Deterministic loopback HTTP fixture. Never retains/logs headers, request bodies or credentials. */
export async function startShopifyStub(responses: StubResponse[] = [], port = 0) {
  let count = 0;
  const server = createServer((request, response) => {
    const fixture = responses[count++];
    request.resume();
    request.on('end', () => {
      const domain = request.headers['x-shopify-shop-domain'] ?? 'demo.myshopify.com';
      response.writeHead(fixture?.status ?? 200, { 'Content-Type': 'application/json', ...fixture?.headers });
      response.end(JSON.stringify(fixture?.body ?? { data: { shop: { name: 'Stub shop', myshopifyDomain: domain } }, extensions: { cost: { requestedQueryCost: 1, actualQueryCost: 1, throttleStatus: { currentlyAvailable: 999, restoreRate: 50 } } } }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Shopify stub did not start.');
  return { url: `http://127.0.0.1:${address.port}/graphql`, requestCount: () => count, close: () => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
