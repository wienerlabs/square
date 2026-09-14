import { describe, it, expect } from "vitest";
import { claimListings, disputes, jobs, type ListPage } from "../src/index.js";
import { address, hash32, openMigratedDatabase } from "./helpers.js";

const CHAIN = 5042002;
const NOW = 1_760_000_000n;
const PAGE_CAP = 50;

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
    status: jobs.JOB_STATUS.open,
    expiredAt: NOW + 86_400n,
    createdAt: NOW - 3_600n,
    fundedAt: null,
    submittedAt: null,
    challengeEnd: null,
    platformFeeBp: 250,
    evaluatorFeeBp: 100,
    deliverable: null,
    payee: null,
    providerBps: null,
    reason: null,
    disputed: false,
    agentId: null,
    updatedBlock: 1_000n,
    refundReason: null,
    ...overrides,
  };
}

function submitted(jobId: bigint, challengeEnd: bigint, evaluator = address(0x03)): jobs.JobRecord {
  return {
    ...job({}),
    jobId,
    evaluator,
    status: jobs.JOB_STATUS.submitted,
    fundedAt: NOW - 3_000n,
    submittedAt: NOW - 600n,
    challengeEnd,
    deliverable: hash32(0xd1),
  };
}

function listing(jobId: bigint): claimListings.ClaimListingRecord {
  return {
    chainId: CHAIN,
    jobId,
    seller: address(0x02),
    buyer: null,
    price: 9_000_000n,
    faceValue: 10_000_000n,
    status: claimListings.CLAIM_LISTING_STATUS.listed,
    updatedBlock: 1_000n,
  };
}

function dispute(jobId: bigint, resolveBy: bigint): disputes.DisputeRecord {
  return {
    chainId: CHAIN,
    jobId,
    disputer: address(0x09),
    bond: 5_000_000n,
    disputedAt: NOW,
    resolveBy,
    setVersion: 1,
    outcome: null,
    providerBps: null,
    closed: false,
    updatedBlock: 1_000n,
  };
}

async function walk(read: (page: ListPage) => Promise<{ jobId: bigint }[]>, limit: number): Promise<bigint[]> {
  const seen: bigint[] = [];
  let after: bigint | undefined;
  for (let page = 0; page < PAGE_CAP; page += 1) {
    const rows = await read({ limit, after });
    expect(rows.length).toBeLessThanOrEqual(limit);
    seen.push(...rows.map((row) => row.jobId));
    if (rows.length < limit) return seen;
    after = rows[rows.length - 1]?.jobId;
  }
  throw new Error("the cursor never reached the end of the list");
}

describe("paging the job lists", () => {
  it("bounds an answer, walks the whole list with a job id cursor and leaves the unpaged read alone", async () => {
    const db = await openMigratedDatabase();
    try {
      for (const jobId of [1n, 2n, 3n, 4n, 5n, 6n, 7n]) await jobs.upsert(db, job({ jobId }));
      await jobs.upsert(db, job({ jobId: 8n, chainId: 1 }));

      const first = await jobs.listOpen(db, CHAIN, { limit: 3 });

      expect(first.map((row) => row.jobId)).toEqual([1n, 2n, 3n]);
      expect((await jobs.listOpen(db, CHAIN, { limit: 3, after: 3n })).map((row) => row.jobId)).toEqual([4n, 5n, 6n]);
      expect((await jobs.listOpen(db, CHAIN, { limit: 3, after: 6n })).map((row) => row.jobId)).toEqual([7n]);
      expect(await jobs.listOpen(db, CHAIN, { limit: 3, after: 7n })).toEqual([]);
      expect(await walk((page) => jobs.listOpen(db, CHAIN, page), 2)).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n]);
      expect((await jobs.listOpen(db, CHAIN)).map((row) => row.jobId)).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n]);
      expect(await jobs.countOpen(db, CHAIN)).toBe(7);
      expect(await jobs.countOpen(db, 1)).toBe(1);
    } finally {
      await db.close();
    }
  });

  it("pages the provider list", async () => {
    const db = await openMigratedDatabase();
    try {
      for (const jobId of [1n, 2n, 3n]) await jobs.upsert(db, job({ jobId }));
      await jobs.upsert(db, job({ jobId: 4n, provider: address(0x07) }));

      expect((await jobs.listByProvider(db, CHAIN, address(0x02), { limit: 2 })).map((row) => row.jobId)).toEqual([1n, 2n]);
      expect(await walk((page) => jobs.listByProvider(db, CHAIN, address(0x02), page), 1)).toEqual([1n, 2n, 3n]);
      expect((await jobs.listByProvider(db, CHAIN, address(0x02))).map((row) => row.jobId)).toEqual([1n, 2n, 3n]);
    } finally {
      await db.close();
    }
  });

  it("walks a challenge window list whose unpaged order is the challenge end, without dropping a row", async () => {
    const db = await openMigratedDatabase();
    try {
      for (const jobId of [1n, 2n, 3n, 4n, 5n]) await jobs.upsert(db, submitted(jobId, NOW + (6n - jobId) * 100n));

      expect((await jobs.listInChallengeWindow(db, CHAIN, NOW)).map((row) => row.jobId)).toEqual([5n, 4n, 3n, 2n, 1n]);
      expect((await jobs.listInChallengeWindow(db, CHAIN, NOW, { limit: 2 })).map((row) => row.jobId)).toEqual([1n, 2n]);
      expect(await walk((page) => jobs.listInChallengeWindow(db, CHAIN, NOW, page), 2)).toEqual([1n, 2n, 3n, 4n, 5n]);
      expect(await jobs.countInChallengeWindow(db, CHAIN, NOW)).toBe(5);
    } finally {
      await db.close();
    }
  });

  it("pages the finalizable list under the evaluator filter it already had", async () => {
    const db = await openMigratedDatabase();
    try {
      for (const jobId of [1n, 2n, 3n, 4n]) await jobs.upsert(db, submitted(jobId, NOW - (5n - jobId) * 100n));
      await jobs.upsert(db, submitted(5n, NOW - 100n, address(0x08)));

      expect((await jobs.listFinalizable(db, CHAIN, NOW)).map((row) => row.jobId)).toEqual([1n, 2n, 3n, 4n, 5n]);
      expect((await jobs.listFinalizable(db, CHAIN, NOW, undefined, { limit: 2 })).map((row) => row.jobId)).toEqual([1n, 2n]);
      expect((await jobs.listFinalizable(db, CHAIN, NOW, address(0x03), { limit: 3 })).map((row) => row.jobId)).toEqual([1n, 2n, 3n]);
      expect((await jobs.listFinalizable(db, CHAIN, NOW, address(0x03), { limit: 3, after: 3n })).map((row) => row.jobId)).toEqual([4n]);
      expect(await walk((page) => jobs.listFinalizable(db, CHAIN, NOW, undefined, page), 2)).toEqual([1n, 2n, 3n, 4n, 5n]);
      expect(await jobs.countFinalizable(db, CHAIN, NOW)).toBe(5);
    } finally {
      await db.close();
    }
  });

  it("refuses a limit that is not a positive whole number", async () => {
    const db = await openMigratedDatabase();
    try {
      await jobs.upsert(db, job({ jobId: 1n }));

      await expect(jobs.listOpen(db, CHAIN, { limit: 0 })).rejects.toThrow(RangeError);
      await expect(jobs.listOpen(db, CHAIN, { limit: -1 })).rejects.toThrow(RangeError);
      await expect(jobs.listOpen(db, CHAIN, { limit: 1.5 })).rejects.toThrow(RangeError);
      expect((await jobs.listOpen(db, CHAIN, {})).map((row) => row.jobId)).toEqual([1n]);
    } finally {
      await db.close();
    }
  });
});

describe("paging the listing and dispute lists", () => {
  it("bounds the listings and walks them", async () => {
    const db = await openMigratedDatabase();
    try {
      for (const jobId of [1n, 2n, 3n, 4n]) await claimListings.upsert(db, listing(jobId));
      await claimListings.upsert(db, { ...listing(5n), status: claimListings.CLAIM_LISTING_STATUS.sold, buyer: address(0x04) });

      expect((await claimListings.listListed(db, CHAIN, { limit: 2 })).map((row) => row.jobId)).toEqual([1n, 2n]);
      expect((await claimListings.listListed(db, CHAIN, { limit: 2, after: 2n })).map((row) => row.jobId)).toEqual([3n, 4n]);
      expect(await walk((page) => claimListings.listListed(db, CHAIN, page), 3)).toEqual([1n, 2n, 3n, 4n]);
      expect((await claimListings.listListed(db, CHAIN)).map((row) => row.jobId)).toEqual([1n, 2n, 3n, 4n]);
    } finally {
      await db.close();
    }
  });

  it("walks the open disputes whose unpaged order is the resolve deadline", async () => {
    const db = await openMigratedDatabase();
    try {
      for (const jobId of [1n, 2n, 3n]) await disputes.upsert(db, dispute(jobId, NOW + (4n - jobId) * 100n));
      await disputes.upsert(db, { ...dispute(4n, NOW), closed: true, outcome: disputes.DISPUTE_OUTCOME.complete, providerBps: 10_000 });

      expect((await disputes.listOpen(db, CHAIN)).map((row) => row.jobId)).toEqual([3n, 2n, 1n]);
      expect((await disputes.listOpen(db, CHAIN, { limit: 2 })).map((row) => row.jobId)).toEqual([1n, 2n]);
      expect(await walk((page) => disputes.listOpen(db, CHAIN, page), 2)).toEqual([1n, 2n, 3n]);
      expect(await disputes.countOpen(db, CHAIN)).toBe(3);
    } finally {
      await db.close();
    }
  });
});
