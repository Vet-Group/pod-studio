import { createServer } from 'node:http';

export interface StubResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}
export const SHOPIFY_STUB_PRODUCTS = [
  { id: 'gid://shopify/Product/101', title: 'Mountain poster', productType: 'Poster', status: 'ACTIVE' },
  { id: 'gid://shopify/Product/102', title: 'Ocean poster', productType: 'Poster', status: 'DRAFT' },
  { id: 'gid://shopify/Product/103', title: '', productType: 'Poster', status: 'ACTIVE' },
  { id: 'gid://shopify/Product/104', title: 'Unrelated mug', productType: 'Mug', status: 'ACTIVE' },
];
/** Deterministic loopback fixture; bodies are parsed transiently, never retained/logged. */
export async function startShopifyStub(responses: StubResponse[] = [], port = 0) {
  let count = 0;
  const server = createServer((request, response) => {
    const fixture = responses[count++];
    let body = '';
    request.on('data', (chunk: Buffer) => {
      if (body.length < 100000) body += chunk.toString();
    });
    request.on('end', () => {
      const domain = request.headers['x-shopify-shop-domain'] ?? 'demo.myshopify.com';
      let data: unknown = { shop: { name: 'Stub shop', myshopifyDomain: domain } };
      try {
        const input = JSON.parse(body) as { query?: string; variables?: { query?: string; after?: string } };
        if (input.query?.includes('ImportProducts')) {
          const type = JSON.parse(input.variables?.query?.replace(/^product_type:/, '') ?? '""') as string;
          const filtered = SHOPIFY_STUB_PRODUCTS.filter((p) => p.productType === type);
          const offset = Number(input.variables?.after?.replace('stub:', '') ?? 0);
          const selected = filtered.slice(offset, offset + 1);
          const endCursor = selected.length ? `stub:${offset + selected.length}` : null;
          data = {
            products: {
              edges: selected.map((p, i) => ({
                cursor: `stub:${offset + i + 1}`,
                node: {
                  ...p,
                  descriptionHtml: '<p>Shopify description</p>',
                  vendor: 'Stub vendor',
                  tags: ['imported'],
                  seo: { title: p.title, description: 'SEO description' },
                  handle: `stub-${p.id.split('/').pop()}`,
                },
              })),
              pageInfo: { hasNextPage: offset + selected.length < filtered.length, endCursor },
            },
          };
        }
      } catch {
        data = null;
      }
      response.writeHead(fixture?.status ?? 200, { 'Content-Type': 'application/json', ...fixture?.headers });
      response.end(
        JSON.stringify(
          fixture?.body ?? {
            data,
            extensions: {
              cost: {
                requestedQueryCost: 1,
                actualQueryCost: 1,
                throttleStatus: { currentlyAvailable: 999, restoreRate: 50 },
              },
            },
          },
        ),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Shopify stub did not start.');
  return {
    url: `http://127.0.0.1:${address.port}/graphql`,
    requestCount: () => count,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
