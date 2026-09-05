import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    // Poseidon setup in circomlibjs is slow on first call, and the optional
    // end-to-end test runs a real Groth16 prove.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
