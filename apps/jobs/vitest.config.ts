import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'jobs',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['../../tests/support/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
