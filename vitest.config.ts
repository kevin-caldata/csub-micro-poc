import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',        // NEVER 'jsdom' — findings/01 gotcha 6
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,        // harness boots a real Fastify server
  },
});
