import { describe, it, expect } from "vitest";
import * as jobEvents from "../src/repositories/jobEvents.js";
import * as jobs from "../src/repositories/jobs.js";
import { hasNullCharacters, jsonParam, stripNullCharacters, NULL_CHARACTER_REPLACEMENT } from "../src/codec.js";
import { address, hash32, openMigratedDatabase } from "./helpers.js";

const CHAIN = 5042002;
const NOW = 1_760_000_000n;
const POISON = "a\u0000b";
const ENCODED_NULL = "\\u0000";

describe("json parameters", () => {
  it("keeps a null character out of the encoded value", () => {
    expect(JSON.stringify(POISON)).toContain(ENCODED_NULL);
    expect(jsonParam({ description: POISON })).not.toContain(ENCODED_NULL);
    expect(jsonParam({ description: POISON })).toContain(NULL_CHARACTER_REPLACEMENT);
  });

  it("reaches nested values and object keys", () => {
    const value = { decoded: { [POISON]: [POISON, { deep: POISON }] } };
    expect(hasNullCharacters(value)).toBe(true);
    const clean = stripNullCharacters(value);
    expect(hasNullCharacters(clean)).toBe(false);
    expect(JSON.stringify(clean)).not.toContain(ENCODED_NULL);
  });

  it("leaves everything else untouched", () => {
    const value = { a: 1, b: true, c: null, d: ["x", 2], e: { f: "ok" } };
    expect(stripNullCharacters(value)).toEqual(value);
    expect(hasNullCharacters(value)).toBe(false);
    expect(jsonParam(value)).toBe(JSON.stringify(value));
  });

  it("survives a jsonb bind, which a bare stringify does not", async () => {
    const db = await openMigratedDatabase();
    try {
      await expect(
        db.query(
          "insert into job_events (chain_id, block_number, log_index, tx_hash, contract, name, job_id, args) values ($1, $2, $3, $4, $5, $6, $7, $8)",
          [CHAIN, "1", 0, Buffer.alloc(32), "SquareJob", "JobDescribed", "1", JSON.stringify({ decoded: { description: POISON } })],
        ),
      ).rejects.toThrow();

      const inserted = await jobEvents.insertIfAbsent(db, {
        chainId: CHAIN,
        blockNumber: 2n,
        logIndex: 0,
        txHash: hash32(0xab),
        contract: "SquareJob",
        name: "JobDescribed",
        jobId: 1n,
        args: { decoded: { description: POISON } },
      });
      expect(inserted).toBe(true);
    } finally {
      await db.close();
    }
  });
});

describe("candidate queries filter by evaluator", () => {
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
      challengeEnd: NOW - 60n,
      platformFeeBp: 250,
      evaluatorFeeBp: 100,
      deliverable: hash32(0xd1),
      payee: null,
      providerBps: null,
      reason: null,
      disputed: false,
      agentId: null,
      updatedBlock: 1_000n,
      ...overrides,
    };
  }

  it("drops jobs settled by a third-party evaluator", async () => {
    const db = await openMigratedDatabase();
    try {
      const ours = address(0x03);
      const theirs = address(0x99);
      await jobs.upsert(db, job({ jobId: 1n, evaluator: ours }));
      await jobs.upsert(db, job({ jobId: 2n, evaluator: theirs }));
      await jobs.upsert(db, job({ jobId: 3n, evaluator: ours, disputed: true }));
      await jobs.upsert(db, job({ jobId: 4n, evaluator: theirs, disputed: true }));

      expect((await jobs.listFinalizable(db, CHAIN, NOW)).map((row) => row.jobId)).toEqual([1n, 2n]);
      expect((await jobs.listFinalizable(db, CHAIN, NOW, ours)).map((row) => row.jobId)).toEqual([1n]);
      expect((await jobs.listDisputedSubmitted(db, CHAIN)).map((row) => row.jobId)).toEqual([3n, 4n]);
      expect((await jobs.listDisputedSubmitted(db, CHAIN, ours)).map((row) => row.jobId)).toEqual([3n]);
    } finally {
      await db.close();
    }
  });
});
