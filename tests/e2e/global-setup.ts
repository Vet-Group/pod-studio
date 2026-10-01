import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request, type FullConfig } from '@playwright/test';
import postgres from 'postgres';
import { createDatabase } from '../../packages/db/src';
import { changePassword } from '../../packages/core/src/auth';
import { assertTestEnvironment } from '../support/environment';
import { serverSettings } from '../support/db';
import { createTestBucket, storageSettings } from '../support/storage';
import { assertSafeDatabase } from '../support/guard';
import { startShopifyStub } from '../support/shopify-stub';
import { e2eConnection, migrate, seedAdmin } from './fixtures';

function maintenance() {
  const pg = serverSettings();
  assertSafeDatabase({ host: pg.host, port: pg.port, database: 'guard_probe_test' });
  return postgres({ host: pg.host, port: pg.port, user: pg.user, password: pg.password, database: pg.adminDatabase, max: 1, onnotice: () => {} });
}

/**
 * Creates and migrates this run's database, bootstraps its admin through the same code as
 * `pnpm auth:create-admin`, gives it a permanent password and saves a signed-in browser state for
 * specs that only need "some signed-in user". Returns the teardown that drops the database.
 */
export default async function globalSetup(config: FullConfig) {
  assertTestEnvironment();
  const database = process.env.POD_E2E_DATABASE!;
  assertSafeDatabase({ ...serverSettings(), database });

  const root = maintenance();
  try {
    await root.unsafe(`CREATE DATABASE "${database}"`);
  } finally {
    await root.end({ timeout: 5 });
  }
  await migrate(database);
  const bucket = await createTestBucket(storageSettings(), process.env.POD_E2E_BUCKET);

  const admin = await seedAdmin(database);
  const password = `e2e-admin-${Date.now()}-password`;
  const handle = createDatabase(e2eConnection(database), { max: 1 });
  try {
    await changePassword(handle.db, { userId: admin.userId, currentPassword: admin.password, newPassword: password });
  } finally {
    await handle.close();
  }
  process.env.POD_E2E_ADMIN_ID = admin.userId;
  process.env.POD_E2E_ADMIN_EMAIL = admin.email;
  process.env.POD_E2E_ADMIN_PASSWORD = password;

  const baseURL = config.projects[0]!.use.baseURL!;
  const stateDir = mkdtempSync(join(tmpdir(), 'pod-e2e-'));
  const statePath = join(stateDir, 'admin.json');
  const api = await request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
  const signIn = await api.post('/api/auth/sign-in/email', { data: { email: admin.email, password } });
  if (!signIn.ok()) throw new Error(`E2E admin sign-in failed: ${signIn.status()} ${await signIn.text()}`);
  await api.storageState({ path: statePath });

  // `next dev` compiles each route on first request, and parallel first requests to one route can
  // read a half-written manifest ("Unexpected end of JSON input"). Compile every route once, in turn.
  for (const path of ['/', '/studio', '/stores', '/stores/warm-up/members', '/stores/warm-up/settings', '/change-password', '/not-a-page', '/api/auth/get-session']) {
    await api.get(path);
  }
  const anonymous = await request.newContext({ baseURL });
  for (const path of ['/login', '/invite/warm-up']) await anonymous.get(path);
  await anonymous.dispose();
  await api.dispose();
  process.env.POD_E2E_ADMIN_STATE = statePath;
  const shopifyStub = await startShopifyStub([], Number(process.env.SHOPIFY_STUB_PORT));

  return async () => {
    await shopifyStub.close();
    await bucket.drop();
    rmSync(stateDir, { recursive: true, force: true });
    const cleanup = maintenance();
    try {
      await cleanup.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    } finally {
      await cleanup.end({ timeout: 5 });
    }
  };
}
