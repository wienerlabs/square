import { describe, it, expect } from "vitest";
import * as jobEvents from "../src/repositories/jobEvents.js";
import { hash32, openMigratedDatabase } from "./helpers.js";

describe("jobEvents.insertIfAbsent", () => {
  it("inserts once per (chain_id, block_number, log_index)", async () => {
    const db = await openMigratedDatabase();
    try {
      const event: jobEvents.JobEventRecord = {
        chainId: 5042002,
        blockNumber: 123456789n,
        logIndex: 7,
        txHash: hash32(0xab),
        contract: "SquareJob",
        name: "JobCreated",
        jobId: 2n ** 255n,
        args: { client: "0x11", budget: "1000000" },
      };
      expect(await jobEvents.insertIfAbsent(db, event)).toBe(true);
      expect(await jobEvents.insertIfAbsent(db, event)).toBe(false);
      expect(await jobEvents.insertIfAbsent(db, { ...event, logIndex: 8 })).toBe(true);
      expect(await jobEvents.insertIfAbsent(db, { ...event, chainId: 1 })).toBe(true);

      const { rows } = await db.query<{ job_id: string; args: unknown; n: string }>(
        "select job_id, args, count(*) over () as n from job_events where chain_id = $1 and log_index = $2",
        [5042002, 7],
      );
      expect(rows[0]?.job_id).toBe((2n ** 255n).toString());
      expect(rows[0]?.args).toEqual(event.args);
    } finally {
      await db.close();
    }
  });
});
