import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The CLI runs in spawned subprocesses during tests (deterministic
      // smoke and end-to-end coverage live in tests/integration/cli.test.ts),
      // so v8 in-process coverage cannot see it.
      exclude: ['src/cli/**'],
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 60,
      },
    },
  },
});
