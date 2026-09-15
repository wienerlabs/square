import { defineConfig } from "vitest/config";
// One anvil is shared by every file that talks to a chain, and some of them move
// its clock. Files run one after another so one suite's time travel is never
// another suite's broken assumption.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], fileParallelism: false } });
