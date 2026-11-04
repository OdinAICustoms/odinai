import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['test/env.ts'],
    fileParallelism: false,      // one test database, used by one file at a time
    testTimeout: 20000,
    hookTimeout: 30000
  }
});
