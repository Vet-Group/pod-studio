import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTestEnvironment } from './environment';
import { serverSettings } from './db';
import { storageSettings } from './storage';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const compose = join(root, 'ops', 'local', 'docker-compose.yml');

function reachable(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Vitest global setup: refuse unsafe targets first, then make sure the local Postgres and MinIO from
 * ops/local/docker-compose.yml are up. Set TEST_SKIP_SERVICES_UP=1 to manage the services yourself.
 */
export default async function setup(): Promise<void> {
  assertTestEnvironment();

  const pg = serverSettings();
  const s3 = new URL(storageSettings().endpoint);
  const s3Port = Number(s3.port || 80);
  const up = async () => (await reachable(pg.host, pg.port)) && (await reachable(s3.hostname, s3Port));
  if (await up()) return;

  if (process.env.TEST_SKIP_SERVICES_UP === '1') {
    throw new Error('Local Postgres or MinIO is not reachable. Start them with `pnpm services:up`.');
  }
  console.log('[test] starting local services: docker compose up -d --wait');
  execFileSync('docker', ['compose', '-f', compose, 'up', '-d', '--wait'], { stdio: 'inherit' });
  if (!(await up())) throw new Error('Local services did not become reachable after `docker compose up`.');
}
