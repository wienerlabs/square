import { defineConfig } from "vitest/config";

// One chain, one set of accounts, one file at a time.
//
// test/anvil.test.ts and test/sync.test.ts both drive the anvil on
// 127.0.0.1:8545 and both fund jobs from the same `anvilAccount(index)`
// addresses. vitest runs test files concurrently by default, so the two
// interleave and one occasionally finds the balance already spent — seen once
// as `fund` reverting with 28 USDC held against 40 needed.
//
// The race is not new; it was unreachable. Before square#43 the `(anvil)` job
// never started a chain, so both files hit `describe.skipIf(!reachable)` and
// skipped, and the job reported 7 of 10 tests green. Starting the chain is what
// made these tests run, and running them is what exposed this.
//
// Serialising the files is the smallest fix that is actually correct. Giving
// each file its own chain or its own accounts would work too and costs more to
// maintain than it saves, since these suites are seconds long.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
  },
});
