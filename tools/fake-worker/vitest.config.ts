import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'fake-worker',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['../../tests/support/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
