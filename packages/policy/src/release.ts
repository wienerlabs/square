import { complianceModuleAbi, JobStatus, type SquareClient } from "@squaresdk/core";
import { isAddressEqual, parseEventLogs, type Address, type Hex, type TransactionReceipt } from "viem";
import { policyCommitment } from "./commitment.js";
import type { Policy } from "./policy.js";
import { decodeComplianceProof, encodeComplianceProof, signalsOf, type ProofSignals } from "./proof.js";
import { proveRequest, type Prover, type ViolatedRule } from "./prover.js";

/**
 * What the module will bind a proof to at release, read from the chain
 * (docs/design/compliance-gate.md, "the eight bindings"): the payee the hook
 * resolves, the net after fees, the token, the day's counter and the clock.
 * Every one of them can move between funding and release: a sold receivable
 * changes the payee, a fee notice the net, every release of the day the
 * counter, and the clock always. A proof is a statement about one set of
 * these, so it is built from them and kept current against them.
 */
export interface ReleaseFacts {
  jobId: bigint;
  status: number;
  client: Address;
  payee: Address;
  /** What the payee receives: the net, times the split a decided dispute set. */
  amount: bigint;
  /** `netPayout(jobId)`: the escrow after fees, before any split. */
  net: bigint;
  /** The payee's share in basis points: 10 000 on the optimistic path, what the arbiters decided otherwise, null while a dispute is open. */
  providerBps: number | null;
  token: Address;
  dailySpentBefore: bigint;
  /** The chain's clock: the latest block's timestamp. */
  now: bigint;
  /** `PolicyRegistry.commitmentOf(client)`, zero when the client committed no policy. */
  commitment: Hex;
  challengeEnd: bigint | null;
  disputed: boolean;
}

export async function releaseFacts(client: SquareClient, jobId: bigint): Promise<ReleaseFacts> {
  const record = await client.getJobRecord(jobId);
  const [payee, amount, spent, block, policy] = await Promise.all([
    client.payeeOf(jobId),
    client.netPayout(jobId),
    client.spentToday(record.client),
    client.publicClient.getBlock({ blockTag: "latest" }),
    client.policyOf(record.client),
  ]);
  const submitted = record.status === JobStatus.Submitted;
  const [challengeEnd, disputed] = submitted ? await Promise.all([client.challengeEndsAt(jobId), client.isDisputed(jobId)]) : [null, false];
  // The hook hands the module `net * providerBps / 10 000`: the whole net on
  // the optimistic path, the arbiters' split once a dispute is decided.
  let providerBps: number | null = 10_000;
  if (disputed) {
    const dispute = await client.disputeOf(jobId);
    providerBps = dispute.outcome === 0 ? null : Number(dispute.providerBps);
  }
  const payout = providerBps === null ? amount : (amount * BigInt(providerBps)) / 10_000n;
  return {
    jobId,
    status: record.status,
    client: record.client,
    payee,
    amount: payout,
    net: amount,
    providerBps,
    token: client.deployment.usdc,
    dailySpentBefore: spent,
    now: block.timestamp,
    commitment: policy.commitment,
    challengeEnd: challengeEnd === null ? null : BigInt(challengeEnd),
    disputed,
  };
}

export type ProofState =
  | { kind: "none" }
  | { kind: "malformed" }
  | { kind: "current"; signals: ProofSignals; age: bigint }
  | { kind: "stale"; signals: ProofSignals; age: bigint; reasons: string[] };

const abs = (value: bigint): bigint => (value < 0n ? -value : value);

/**
 * Whether the proof a job carries still describes the release the chain
 * would make now. `refreshAfter` is how old a proof may grow before it is
 * rebuilt, in seconds: under the module's tolerance by enough that the
 * releasing block, which comes after this check, is still inside it.
 */
export function proofState(bound: Hex, facts: ReleaseFacts, refreshAfter: bigint): ProofState {
  if (bound === "0x") return { kind: "none" };
  const proof = decodeComplianceProof(bound);
  if (proof === null) return { kind: "malformed" };
  const signals = signalsOf(proof);
  const age = abs(facts.now - signals.timestamp);
  const reasons: string[] = [];
  if (!signals.isCompliant) reasons.push("the proof says the payment is not compliant");
  if (`0x${signals.policyDataHash.toString(16).padStart(64, "0")}` !== facts.commitment.toLowerCase()) reasons.push("the policy commitment changed");
  if (!isAddressEqual(signals.recipient, facts.payee)) reasons.push(`the payee is ${facts.payee}, the proof names ${signals.recipient}`);
  if (signals.amount !== facts.amount) reasons.push(`the net is ${facts.amount}, the proof names ${signals.amount}`);
  if (!isAddressEqual(signals.token, facts.token)) reasons.push("the token differs");
  if (signals.dailySpentBefore !== facts.dailySpentBefore) reasons.push(`the day's counter is ${facts.dailySpentBefore}, the proof names ${signals.dailySpentBefore}`);
  if (age > refreshAfter) reasons.push(`the proof is ${age}s old`);
  return reasons.length === 0 ? { kind: "current", signals, age } : { kind: "stale", signals, age, reasons };
}

export interface BindOptions {
  client: SquareClient;
  policy: Policy;
  prover: Prover;
  jobId: bigint;
  /** The capability the job bought; one of the policy's `allowed_endpoint_categories`. */
  category: string;
  facts?: ReleaseFacts | undefined;
  signal?: AbortSignal | undefined;
}

export type BindOutcome =
  | { bound: true; proof: Hex; transaction: Hex; facts: ReleaseFacts }
  | { bound: false; reason: "not-compliant"; violated: ViolatedRule[] | null; facts: ReleaseFacts }
  | { bound: false; reason: "policy-not-committed" | "policy-differs" | "not-this-client" | "module-refuses" | "terminal"; detail: string; facts: ReleaseFacts };

/**
 * Build the proof for this job's release as it stands now, and bind it.
 *
 * Refuses before proving when the chain holds no commitment for the client
 * or a different one from this policy's (a proof under the wrong commitment
 * is refused at release, so it is refused here, before the prover's seconds
 * and the transaction's gas). A proof the circuit marks non-compliant is
 * reported and not bound: binding it would only make the module say the
 * same thing, and the rules it names are the answer the institution needs.
 * The module's own `previewRelease` is asked last, so a proof the module
 * would refuse for a reason this code did not foresee never reaches the job.
 */
export async function bindComplianceProof(options: BindOptions): Promise<BindOutcome> {
  const { client, policy, prover, jobId } = options;
  const facts = options.facts ?? (await releaseFacts(client, jobId));
  if (facts.status !== JobStatus.Funded && facts.status !== JobStatus.Submitted) {
    return { bound: false, reason: "terminal", detail: `job ${jobId} is not Funded or Submitted`, facts };
  }
  if (!isAddressEqual(facts.client, client.account)) {
    return { bound: false, reason: "not-this-client", detail: `job ${jobId} belongs to client ${facts.client}, this wallet is ${client.account}`, facts };
  }
  if (facts.commitment === `0x${"0".repeat(64)}`) {
    return { bound: false, reason: "policy-not-committed", detail: `${client.account} has committed no policy; run the commit first`, facts };
  }
  const commitment = await policyCommitment(policy);
  if (commitment.hex.toLowerCase() !== facts.commitment.toLowerCase()) {
    return { bound: false, reason: "policy-differs", detail: `the chain holds commitment ${facts.commitment}, this policy computes ${commitment.hex}`, facts };
  }
  const response = await prover.prove(
    proveRequest(policy, {
      recipient: facts.payee,
      amount: facts.amount,
      token: facts.token,
      category: options.category,
      dailySpentBefore: facts.dailySpentBefore,
      timestamp: facts.now,
    }),
    { signal: options.signal },
  );
  if (!response.is_compliant) return { bound: false, reason: "not-compliant", violated: response.violated_rules, facts };
  const proof = encodeComplianceProof(response.solidity);
  const preview = await client.previewRelease({ jobId, payee: facts.payee, amount: facts.amount, client: facts.client, proof });
  if (preview === false) {
    return { bound: false, reason: "module-refuses", detail: "the installed module refuses the proof it was built for; the verifier and the prover's key may differ", facts };
  }
  const result = await client.setComplianceProof(jobId, proof);
  return { bound: true, proof, transaction: result.hash, facts };
}

/** What the module said when a job was released, read from the receipt. */
export function moduleVerdict(receipt: TransactionReceipt, module: Address): { verified: boolean; reason?: Hex } | null {
  const logs = parseEventLogs({ abi: complianceModuleAbi, logs: receipt.logs });
  for (const log of logs) {
    if (!isAddressEqual(log.address, module)) continue;
    if (log.eventName === "ReleaseVerified") return { verified: true };
    if (log.eventName === "ReleaseRefused") return { verified: false, reason: log.args.reason };
  }
  return null;
}
