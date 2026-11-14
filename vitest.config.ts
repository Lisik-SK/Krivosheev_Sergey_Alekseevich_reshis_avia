import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/api/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      include: ['src/shared/**', 'src/server/**', 'src/cli/**'],
      reporter: ['text-summary', 'text'],
    },
  },
});
