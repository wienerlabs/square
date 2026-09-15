import { JobStatus, type SquareClient } from "@squaresdk/core";
import type { Address, Hex } from "viem";
import { decodeComplianceProof, encodeComplianceProof, signalsOf } from "../../src/proof.js";
import type { ProveRequest, ProveResponse, Prover } from "../../src/prover.js";

/**
 * A chain for the duty's decisions: the reads it makes, the two writes it
 * sends, and a module that judges a proof by its signals the way the real
 * one does (recipient, amount, token, counter, commitment, clock) without a
 * pairing check. The prover here answers with a "proof" whose public signals
 * are the request's, so what the duty binds is inspectable.
 */
export const CLIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
export const PROVIDER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
export const BUYER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as const;
export const USDC = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
export const MODULE = "0x000000000000000000000000000000000000c0de" as const;
export const ZERO32 = `0x${"0".repeat(64)}` as const;

export interface FakeJob {
  status: number;
  client: Address;
  provider: Address;
  payee: Address;
  net: bigint;
  challengeEnd: bigint | null;
  disputed: boolean;
  /** 0 while open; the arbiters' outcome once decided, with the payee's share. */
  outcome?: number;
  providerBps?: number;
  proof: Hex;
}

export interface FakeChain {
  client: SquareClient;
  prover: Prover;
  jobs: Map<string, FakeJob>;
  now: bigint;
  spent: bigint;
  commitment: Hex;
  module: Address | null;
  tolerance: bigint;
  writes: string[];
  proofs: ProveRequest[];
  /** The block spans the duty's recovery asked for. */
  scans: [bigint, bigint][];
  /** What the module says to a proof, computed from its signals; override to force a verdict. */
  judge: (jobId: bigint, proof: Hex) => boolean;
}

export function fakeChain(options: { commitment: Hex; module?: Address | null; tolerance?: bigint; now?: bigint }): FakeChain {
  const chain: FakeChain = {
    client: undefined as unknown as SquareClient,
    prover: undefined as unknown as Prover,
    jobs: new Map(),
    now: options.now ?? 1_800_000_000n,
    spent: 0n,
    commitment: options.commitment,
    module: options.module === undefined ? MODULE : options.module,
    tolerance: options.tolerance ?? 3_600n,
    writes: [],
    proofs: [],
    scans: [],
    judge: (jobId, proof) => {
      const decoded = decodeComplianceProof(proof);
      if (decoded === null) return false;
      const s = signalsOf(decoded);
      const job = chain.jobs.get(jobId.toString())!;
      const age = chain.now > s.timestamp ? chain.now - s.timestamp : s.timestamp - chain.now;
      const share = job.disputed && (job.outcome ?? 0) !== 0 ? (job.net * BigInt(job.providerBps ?? 0)) / 10_000n : job.net;
      return (
        s.isCompliant &&
        `0x${s.policyDataHash.toString(16).padStart(64, "0")}` === chain.commitment.toLowerCase() &&
        s.recipient.toLowerCase() === job.payee.toLowerCase() &&
        s.amount === share &&
        s.token.toLowerCase() === USDC.toLowerCase() &&
        s.dailySpentBefore === chain.spent &&
        age <= chain.tolerance
      );
    },
  };
  const job = (id: bigint): FakeJob => {
    const found = chain.jobs.get(id.toString());
    if (!found) throw new Error(`InvalidJob() for ${id}`);
    return found;
  };
  chain.client = {
    account: CLIENT,
    deployment: { chainId: 31337, usdc: USDC, squareJob: "0x" + "11".repeat(20), claimMarket: "0x" + "22".repeat(20), squareHook: "0x" + "33".repeat(20) },
    publicClient: {
      getBlock: async () => ({ timestamp: chain.now, number: 100n }),
      // This wallet's JobCreated logs, for the duty's recovery scan: every job
      // the map holds for CLIENT, whatever its status, the way the chain would.
      getLogs: async (params: { args?: { client?: Address }; fromBlock: bigint; toBlock: bigint }) => {
        chain.scans.push([params.fromBlock, params.toBlock]);
        return [...chain.jobs.entries()]
          .filter(([, j]) => params.args?.client === undefined || j.client.toLowerCase() === params.args.client.toLowerCase())
          .map(([id]) => ({ args: { jobId: BigInt(id) } }));
      },
    },
    async getJobRecord(id: bigint) {
      const j = job(id);
      return { status: j.status, client: j.client, provider: j.provider };
    },
    async payeeOf(id: bigint) {
      return job(id).payee;
    },
    async netPayout(id: bigint) {
      return job(id).net;
    },
    async spentToday() {
      return chain.spent;
    },
    async policyOf() {
      return { commitment: chain.commitment, dailyLimit: 0n, updatedAt: 0n, epoch: 1n };
    },
    async challengeEndsAt(id: bigint) {
      return Number(job(id).challengeEnd ?? 0n);
    },
    async isDisputed(id: bigint) {
      return job(id).disputed;
    },
    async disputeOf(id: bigint) {
      const j = job(id);
      return { outcome: j.outcome ?? 0, providerBps: j.providerBps ?? 0 };
    },
    async finalizeDecided(id: bigint) {
      const j = job(id);
      if (!j.disputed || (j.outcome ?? 0) === 0) throw new Error("NotDecided()");
      chain.now += 1n;
      const share = (j.net * BigInt(j.providerBps ?? 0)) / 10_000n;
      const verified = chain.module === null ? true : chain.judge(id, j.proof);
      j.status = JobStatus.Completed;
      if (verified && chain.module !== null) chain.spent += share;
      chain.writes.push(`finalizeDecided(${id})${verified ? "" : " refused"}`);
      return { hash: `0x${"ef".repeat(32)}`, receipt: { logs: [] }, events: [] };
    },
    async complianceModule() {
      return chain.module;
    },
    async complianceTolerance() {
      return chain.module === null ? null : chain.tolerance;
    },
    async complianceProofOf(id: bigint) {
      return job(id).proof;
    },
    async previewRelease(params: { jobId: bigint; proof: Hex }) {
      return chain.module === null ? null : chain.judge(params.jobId, params.proof);
    },
    async setComplianceProof(id: bigint, proof: Hex) {
      job(id).proof = proof;
      chain.writes.push(`setComplianceProof(${id})`);
      chain.now += 1n;
      return { hash: `0x${"ab".repeat(32)}`, receipt: { logs: [] }, events: [] };
    },
    async finalize(id: bigint) {
      const j = job(id);
      if (j.status !== JobStatus.Submitted) throw new Error("NotSubmitted()");
      if (j.challengeEnd === null || j.challengeEnd > chain.now) throw new Error("WindowOpen()");
      chain.now += 1n;
      const verified = chain.module === null ? true : chain.judge(id, j.proof);
      j.status = JobStatus.Completed;
      if (verified && chain.module !== null) chain.spent += j.net;
      chain.writes.push(`finalize(${id})${verified ? "" : " refused"}`);
      return { hash: `0x${"cd".repeat(32)}`, receipt: { logs: [] }, events: [] };
    },
  } as unknown as SquareClient;
  chain.prover = {
    async prove(request: ProveRequest): Promise<ProveResponse> {
      chain.proofs.push(request);
      const violated: string[] = [];
      if (BigInt(request.payment_amount) > BigInt(request.max_per_transaction)) violated.push("per_transaction_limit");
      if (!request.allowed_endpoint_categories.includes(request.payment_endpoint_category)) violated.push("endpoint_category");
      const compliant = violated.length === 0;
      const input = [
        compliant ? "1" : "0",
        BigInt(chain.commitment).toString(),
        BigInt(request.payment_recipient).toString(),
        request.payment_amount,
        BigInt(request.payment_token).toString(),
        request.daily_spent_before,
        request.current_unix_timestamp,
        "0",
      ];
      return {
        is_compliant: compliant,
        violated_rules: violated as ProveResponse["violated_rules"],
        policy_data_hash: BigInt(chain.commitment).toString(),
        policy_data_hash_hex: chain.commitment,
        public_signals: {},
        solidity: { a: ["1", "2"], b: [["3", "4"], ["5", "6"]], c: ["7", "8"], input },
      };
    },
  };
  return chain;
}

/** A proof for the fake module, with the given signals, as bytes. */
export function proofWith(signals: { commitment: Hex; recipient: Address; amount: bigint; spent: bigint; timestamp: bigint; compliant?: boolean }): Hex {
  return encodeComplianceProof({
    a: ["1", "2"],
    b: [["3", "4"], ["5", "6"]],
    c: ["7", "8"],
    input: [
      signals.compliant === false ? "0" : "1",
      BigInt(signals.commitment).toString(),
      BigInt(signals.recipient).toString(),
      signals.amount.toString(),
      BigInt(USDC).toString(),
      signals.spent.toString(),
      signals.timestamp.toString(),
      "0",
    ],
  });
}

export function fundedJob(overrides: Partial<FakeJob> = {}): FakeJob {
  return { status: JobStatus.Funded, client: CLIENT, provider: PROVIDER, payee: PROVIDER, net: 985_000n, challengeEnd: null, disputed: false, proof: "0x", ...overrides };
}
