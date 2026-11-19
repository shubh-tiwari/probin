import { defineConfig } from 'vitest/config';

// Unit tests: no network, no containers. Integration tests live in *.itest.ts
// and run with `pnpm test:integration` against the local stack.
export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
});
