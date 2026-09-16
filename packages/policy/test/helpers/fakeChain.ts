import { JobStatus, squareHookAbi, type SquareClient } from "@squaresdk/core";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";
import { policyCommitment } from "../../src/commitment.js";
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
export const REGISTRY = "0x00000000000000000000000000000000000005c4" as const;
export const HOOK = "0x3333333333333333333333333333333333333333" as const;
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
  /** The commitment the hook pinned at funding (square#382); undefined for a job funded before the pin. */
  pinned?: Hex;
  /** After it the job can only expire; far away unless a test says otherwise. */
  expiredAt?: bigint;
}

/** A screening record as the registry judges it: fresh and clean clears; fresh and sanctioned is a standing "no"; older than maxAge is nothing. */
export interface FakeScreening {
  screenedAt: bigint;
  sanctioned: boolean;
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
  /** The screening registry the hook holds (square#35); null, the default, screens nobody. */
  screening: Address | null;
  screenings: Map<string, FakeScreening>;
  maxAge: bigint;
  writes: string[];
  proofs: ProveRequest[];
  /** The block spans the duty's recovery asked for. */
  scans: [bigint, bigint][];
  /** What the module says to a proof, computed from its signals; override to force a verdict. */
  judge: (jobId: bigint, proof: Hex) => boolean;
}

export function fakeChain(options: { commitment: Hex; module?: Address | null; tolerance?: bigint; now?: bigint; screening?: Address | null }): FakeChain {
  const chain: FakeChain = {
    client: undefined as unknown as SquareClient,
    prover: undefined as unknown as Prover,
    jobs: new Map(),
    now: options.now ?? 1_800_000_000n,
    spent: 0n,
    commitment: options.commitment,
    module: options.module === undefined ? MODULE : options.module,
    tolerance: options.tolerance ?? 3_600n,
    screening: options.screening ?? null,
    screenings: new Map(),
    maxAge: 3_600n,
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
      // The module binds to the commitment pinned at funding, else the live one (square#382).
      const binds = (job.pinned ?? chain.commitment).toLowerCase();
      return (
        s.isCompliant &&
        `0x${s.policyDataHash.toString(16).padStart(64, "0")}` === binds &&
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
  // The hook's own reading of a payee at release: with a registry, a payee
  // without a fresh, clean record gets nothing and the client the whole net.
  const payeeCleared = (payee: Address): boolean | null => {
    if (chain.screening === null) return null;
    const record = chain.screenings.get(payee.toLowerCase());
    return record !== undefined && !record.sanctioned && chain.now - record.screenedAt <= chain.maxAge;
  };
  // The `ScreeningChecked(jobId, payee, cleared)` log the real hook emits at
  // release while it holds a registry, encoded so the duty decodes it.
  const screeningLogs = (jobId: bigint, payee: Address) => {
    const cleared = payeeCleared(payee);
    if (cleared === null) return [];
    return [
      {
        address: HOOK,
        topics: encodeEventTopics({ abi: squareHookAbi, eventName: "ScreeningChecked", args: { jobId, payee } }),
        data: encodeAbiParameters([{ type: "bool" }], [cleared]),
      },
    ];
  };
  chain.client = {
    account: CLIENT,
    deployment: { chainId: 31337, usdc: USDC, squareJob: "0x" + "11".repeat(20), claimMarket: "0x" + "22".repeat(20), squareHook: HOOK },
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
      return { status: j.status, client: j.client, provider: j.provider, hook: HOOK, expiredAt: j.expiredAt ?? chain.now + 30n * 86_400n };
    },
    async commitmentAtFund(id: bigint) {
      return job(id).pinned ?? null;
    },
    async screening() {
      return chain.screening;
    },
    async screeningOf(subject: Address) {
      if (chain.screening === null) return { subject, state: "no-screening", registry: null };
      const record = chain.screenings.get(subject.toLowerCase());
      const fresh = record !== undefined && chain.now - record.screenedAt <= chain.maxAge;
      const state = fresh ? (record.sanctioned ? "sanctioned" : "cleared") : "unscreened";
      return { subject, state, registry: chain.screening };
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
      const paid = verified && payeeCleared(j.payee) !== false;
      j.status = JobStatus.Completed;
      if (paid && chain.module !== null) chain.spent += share;
      chain.writes.push(`finalizeDecided(${id})${paid ? "" : " refused"}`);
      return { hash: `0x${"ef".repeat(32)}`, receipt: { logs: screeningLogs(id, j.payee) }, events: [] };
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
      const paid = verified && payeeCleared(j.payee) !== false;
      j.status = JobStatus.Completed;
      if (paid && chain.module !== null) chain.spent += j.net;
      chain.writes.push(`finalize(${id})${paid ? "" : " refused"}`);
      return { hash: `0x${"cd".repeat(32)}`, receipt: { logs: screeningLogs(id, j.payee) }, events: [] };
    },
  } as unknown as SquareClient;
  chain.prover = {
    async prove(request: ProveRequest): Promise<ProveResponse> {
      chain.proofs.push(request);
      const violated: string[] = [];
      if (BigInt(request.payment_amount) > BigInt(request.max_per_transaction)) violated.push("per_transaction_limit");
      if (BigInt(request.daily_spent_before) + BigInt(request.payment_amount) > BigInt(request.max_daily_spend)) violated.push("daily_limit");
      if (!request.allowed_endpoint_categories.includes(request.payment_endpoint_category)) violated.push("endpoint_category");
      const compliant = violated.length === 0;
      // A proof under a policy carries that policy's commitment, as the real prover's does.
      const under = (await policyCommitment(request)).hex;
      const input = [
        compliant ? "1" : "0",
        BigInt(under).toString(),
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
        policy_data_hash: BigInt(under).toString(),
        policy_data_hash_hex: under,
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
