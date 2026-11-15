import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// NestJS relies on decorator metadata, which esbuild (Vitest's default
// transformer) does not emit, so tests are compiled with SWC instead.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // PGlite migrations and Argon2 hashing make auth tests slower than unit tests.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      // The pool connects lazily; e2e tests swap in an in-memory database.
      DATABASE_URL: 'postgres://test:test@localhost:5432/test',
      // Tests must not call third-party services.
      BREACHED_PASSWORD_CHECK: 'off',
      LOG_LEVEL: 'error',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/main.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
