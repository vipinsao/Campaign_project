import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@campaign/shared': r('./packages/shared/src/index.ts'),
      '@campaign/core': r('./packages/core/src/index.ts'),
      '@campaign/providers': r('./packages/providers/src/index.ts'),
      '@campaign/triage': r('./packages/triage/src/index.ts'),
      '@campaign/api': r('./packages/api/src/index.ts'),
      '@campaign/worker': r('./packages/worker/src/index.ts'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // One Postgres instance is booted once and shared by every suite that needs it.
    globalSetup: ['tests/support/global-setup.ts'],
    // Integration and invariant suites talk to a real database; run files serially
    // so that FOR UPDATE SKIP LOCKED concurrency tests own their own rows.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**/*.ts'],
      thresholds: { lines: 85, functions: 85, branches: 75, statements: 85 },
    },
  },
});
