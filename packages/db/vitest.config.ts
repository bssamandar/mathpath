import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // PGlite boots a real PostgreSQL (WASM) per test file; give it time.
    testTimeout: 30000,
    hookTimeout: 60000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/cli.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
