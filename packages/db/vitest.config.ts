import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'db',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Same guard + local services bootstrap as the root support tests.
    globalSetup: ['../../tests/support/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
