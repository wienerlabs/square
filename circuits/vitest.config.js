import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    // Witness generation over the full circuit is not fast, and the proof
    // round-trip in payment.test.js runs a real Groth16 prove.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
