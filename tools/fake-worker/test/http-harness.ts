import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach } from 'vitest';
import { workerHarness } from '../../../tests/contract/harness';
import type { WorkerOperation } from '../../../apps/web/src/features/workers/handler';
import { WorkerClient, type JobType } from '../src/client';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

/** Only transports HTTP into the production dispatcher; no API behavior is mocked. */
export async function httpHarness() {
  const h = await workerHarness();
  const trace: Array<{ operation: WorkerOperation; status: number; body: unknown }> = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      const path = new URL(incoming.url!, 'http://localhost').pathname.replace('/api/worker/v2/', '');
      const parts = path.split('/');
      const operation = (parts[0] === 'jobs' ? parts[2] : parts[0] === 'accounts' ? 'account-status' : parts[0]) as WorkerOperation;
      const id = parts.length > 1 ? parts[1] : undefined;
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      }
      const response = await h.api.dispatch(new Request(`http://127.0.0.1${incoming.url}`, {
        method: incoming.method, headers, body: Buffer.concat(chunks),
      }), operation, id);
      const text = await response.text();
      // Do not retain authorization headers, tokens, or presigned upload/read URLs.
      const body = ['heartbeat', 'complete', 'fail', 'account-status'].includes(operation) && text ? JSON.parse(text) as unknown : undefined;
      trace.push({ operation, status: response.status, body });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(text);
    } catch {
      outgoing.writeHead(500);
      outgoing.end('HTTP test adapter failed');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(async () => {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
  const baseUrl = `http://127.0.0.1:${address.port}/api/worker/v2`;
  const client = new WorkerClient({ baseUrl, token: h.token, retries: 0 });
  const jobTypes: JobType[] = ['mockup', 'redesign', 'listing_content', 'product_analysis'];
  const registration = await client.register({
    workerKey: 'browser-01@studio', host: 'fake-worker-test', version: '0.0.0',
    accounts: [{ accountKey: 'chatgpt-account', provider: 'chatgpt', channel: 'browser', jobTypes, maxConcurrency: 16, installedSkills: [] }],
  });
  const claim = () => client.claim({ workerId: registration.workerId, accountId: registration.accounts[0]!.accountId, waitSeconds: 0 });
  return { ...h, client, baseUrl, registration, claim, trace };
}
