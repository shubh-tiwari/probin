import { defineConfig } from 'vitest/config';

// Integration tests need the local stack (`make dev`).
export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.itest.ts', 'scripts/**/*.itest.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
