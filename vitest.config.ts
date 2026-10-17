import { defineConfig } from 'vitest/config';

// Tests run in Node. D1 is replaced by an in-memory SQLite adapter (test/d1-shim.ts) that applies the
// real migrations from ./migrations, so the same SQL that runs in production is exercised by the tests.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
  },
});
