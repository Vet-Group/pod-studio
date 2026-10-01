import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.WEB_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${port}`;
const shopifyStubPort = port + 10000;
const shopifyEncryptionKey = randomBytes(32).toString('base64');
process.env.SHOPIFY_STUB_PORT = String(shopifyStubPort);

/*
 * Every E2E run gets its own migrated `pod_e2e_<random>_test` database (tests/e2e/global-setup.ts)
 * and a throwaway auth secret. This file is evaluated in the runner first and its env is inherited by
 * the web server and the workers, so the values are fixed once per run here.
 */
process.env.POD_E2E_DATABASE ??= `pod_e2e_${randomBytes(4).toString('hex')}_test`;
process.env.POD_E2E_AUTH_SECRET ??= randomBytes(32).toString('base64url');
process.env.POD_E2E_BUCKET ??= `pod-e2e-${randomBytes(4).toString('hex')}-test`;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts',
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
  ],
  webServer: {
    command: `pnpm --filter @pod-studio/web exec next dev --port ${port}`,
    url: `${baseURL}/api/health`,
    // A reused server would talk to another database; every run starts its own.
    reuseExistingServer: false,
    timeout: 120_000,
    // Explicit values win over apps/web/.env.local, so a run never reads or writes pod_dev.
    env: {
      DATABASE_URL: '',
      PGHOST: process.env.TEST_PGHOST ?? '127.0.0.1',
      PGPORT: process.env.TEST_PGPORT ?? '54316',
      PGUSER: process.env.TEST_PGUSER ?? 'pod',
      PGPASSWORD: process.env.TEST_PGPASSWORD ?? 'pod-local-only',
      PGDATABASE: process.env.POD_E2E_DATABASE,
      S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:19000',
      S3_PUBLIC_ENDPOINT: '',
      S3_REGION: process.env.TEST_S3_REGION ?? 'us-east-1',
      S3_ACCESS_KEY_ID: process.env.TEST_S3_ACCESS_KEY_ID ?? 'podlocal',
      S3_SECRET_ACCESS_KEY: process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'pod-local-only',
      S3_BUCKET: process.env.POD_E2E_BUCKET,
      BETTER_AUTH_SECRET: process.env.POD_E2E_AUTH_SECRET,
      BETTER_AUTH_URL: baseURL,
      SHOPIFY_ENCRYPTION_KEYS: `v1:${shopifyEncryptionKey}`,
      SHOPIFY_ENCRYPTION_ACTIVE_VERSION: 'v1',
      SHOPIFY_ENDPOINT_OVERRIDE: `http://127.0.0.1:${shopifyStubPort}/graphql`,
      BETTER_AUTH_TRUSTED_ORIGINS: baseURL,
    },
  },
});
