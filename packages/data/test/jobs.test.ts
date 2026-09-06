import { describe, it, expect } from "vitest";
import * as jobs from "../src/repositories/jobs.js";
import { address, hash32, openMigratedDatabase } from "./helpers.js";

const CHAIN = 5042002;
const NOW = 1_760_000_000n;

function job(overrides: Partial<jobs.JobRecord>): jobs.JobRecord {
  return {
    chainId: CHAIN,
    jobId: 1n,
    client: address(0x01),
    provider: address(0x02),
    evaluator: address(0x03),
    hook: null,
    description: "translate a document",
    budget: 25_000_000n,
    status: jobs.JOB_STATUS.submitted,
    expiredAt: NOW + 86_400n,
    createdAt: NOW - 3_600n,
    fundedAt: NOW - 3_000n,
    submittedAt: NOW - 600n,
    challengeEnd: NOW + 600n,
    platformFeeBp: 250,
    evaluatorFeeBp: 100,
    deliverable: hash32(0xd1),
    payee: null,
    providerBps: null,
    reason: null,
    disputed: false,
    agentId: 2n ** 200n,
    updatedBlock: 1_000n,
    ...overrides,
  };
}

describe("jobs", () => {
  it("lists only submitted, undisputed jobs whose challenge window is still open", async () => {
    const db = await openMigratedDatabase();
    try {
      expect(await jobs.upsert(db, job({ jobId: 1n }))).toBe(true);
      expect(await jobs.upsert(db, job({ jobId: 2n, disputed: true }))).toBe(true);
      expect(await jobs.upsert(db, job({ jobId: 3n, challengeEnd: NOW - 1n }))).toBe(true);
      expect(await jobs.upsert(db, job({ jobId: 4n, status: jobs.JOB_STATUS.funded, challengeEnd: null, submittedAt: null }))).toBe(true);
      expect(await jobs.upsert(db, job({ jobId: 5n, status: jobs.JOB_STATUS.completed }))).toBe(true);
      expect(await jobs.upsert(db, job({ jobId: 6n, challengeEnd: NOW }))).toBe(true);
      expect(await jobs.upsert(db, job({ jobId: 1n, chainId: 1 }))).toBe(true);

      const inWindow = await jobs.listInChallengeWindow(db, CHAIN, NOW);
      expect(inWindow.map((row) => row.jobId)).toEqual([1n]);
      expect(inWindow[0]).toEqual(job({ jobId: 1n }));

      expect((await jobs.listOpen(db, CHAIN)).map((row) => row.jobId)).toEqual([4n]);
      expect((await jobs.listByProvider(db, CHAIN, address(0x02))).map((row) => row.jobId)).toEqual([1n, 2n, 3n, 4n, 5n, 6n]);
      expect(await jobs.listByProvider(db, CHAIN, address(0x09))).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("round-trips every column and never regresses to an older block", async () => {
    const db = await openMigratedDatabase();
    try {
      const created = job({ jobId: 7n, updatedBlock: 10n });
      await jobs.upsert(db, created);
      expect(await jobs.get(db, CHAIN, 7n)).toEqual(created);
      expect(await jobs.get(db, 1, 7n)).toBeNull();

      const completed = job({ jobId: 7n, status: jobs.JOB_STATUS.completed, payee: address(0x02), providerBps: 10_000, updatedBlock: 12n });
      expect(await jobs.upsert(db, completed)).toBe(true);
      expect(await jobs.upsert(db, job({ jobId: 7n, status: jobs.JOB_STATUS.open, updatedBlock: 11n }))).toBe(false);
      expect(await jobs.get(db, CHAIN, 7n)).toEqual(completed);

      const uppercase = job({ jobId: 8n, client: address(0xab).toUpperCase().replace("0X", "0x") as jobs.JobRecord["client"] });
      await jobs.upsert(db, uppercase);
      expect((await jobs.get(db, CHAIN, 8n))?.client).toBe(address(0xab));
    } finally {
      await db.close();
    }
  });
});
