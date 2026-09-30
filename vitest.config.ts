import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'support',
          include: ['tests/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/support/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      'apps/*/vitest.config.ts',
    ],
  },
});
