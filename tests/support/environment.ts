import { assertSafeDatabase, assertSafeDatabaseUrl, assertSafeS3Endpoint } from './guard';
import { serverSettings } from './db';
import { storageSettings } from './storage';

/**
 * Validates every database and storage target a test run could reach. Called from the Vitest
 * global setup before any test file loads, so a production URL stops the whole run immediately.
 */
export function assertTestEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  if (env.DATABASE_URL) assertSafeDatabaseUrl(env.DATABASE_URL);
  const pg = serverSettings(env);
  assertSafeDatabase({ host: pg.host, port: pg.port, database: 'guard_probe_test' });
  if (env.S3_ENDPOINT) assertSafeS3Endpoint(env.S3_ENDPOINT);
  assertSafeS3Endpoint(storageSettings(env).endpoint);
}
