import { complianceModuleAbi, JobStatus, squareHookAbi, type SquareClient } from "@squaresdk/core";
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
  /** The hook the job was created with: where its screening, if any, is read from. */
  hook: Address;
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
  /**
   * The commitment the module binds the proof to: the one the hook pinned
   * when the job was funded (square#382), else `PolicyRegistry.commitmentOf(client)`,
   * zero when the client committed no policy.
   */
  commitment: Hex;
  /** `PolicyRegistry.commitmentOf(client)` as it stands now, which is `commitment` unless the client committed another policy since funding. */
  liveCommitment: Hex;
  /** The commitment pinned at funding, null when the hook pinned nothing for this job. */
  pinnedCommitment: Hex | null;
  challengeEnd: bigint | null;
  disputed: boolean;
  /** The job's `expiredAt`: after it the job can only expire, so a refusal still waiting is bound before it. */
  expiredAt: bigint;
}

export async function releaseFacts(client: SquareClient, jobId: bigint): Promise<ReleaseFacts> {
  const record = await client.getJobRecord(jobId);
  const [payee, amount, spent, block, policy, pinned] = await Promise.all([
    client.payeeOf(jobId),
    client.netPayout(jobId),
    client.spentToday(record.client),
    client.publicClient.getBlock({ blockTag: "latest" }),
    client.policyOf(record.client),
    client.commitmentAtFund(jobId, record.hook),
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
    hook: record.hook,
    payee,
    amount: payout,
    net: amount,
    providerBps,
    token: client.deployment.usdc,
    dailySpentBefore: spent,
    now: block.timestamp,
    commitment: pinned ?? policy.commitment,
    liveCommitment: policy.commitment,
    pinnedCommitment: pinned,
    challengeEnd: challengeEnd === null ? null : BigInt(challengeEnd),
    disputed,
    expiredAt: BigInt(record.expiredAt),
  };
}

/**
 * The rules a refusal can be waited out of. `daily_limit` clears when the
 * day's counter resets, as long as the amount alone fits under the ceiling;
 * `time_window` clears when the policy's hours come round. Every other rule,
 * the category, the recipient, the token, the per-transaction ceiling, says
 * the same tomorrow, and a refusal on one of those is the mandate's answer
 * for the job.
 */
export function refusalIsTransient(violated: ViolatedRule[] | null, facts: Pick<ReleaseFacts, "amount">, policy: Pick<Policy, "max_daily_spend">): boolean {
  if (violated === null || violated.length === 0) return false;
  return violated.every((rule) => rule === "time_window" || (rule === "daily_limit" && facts.amount <= BigInt(policy.max_daily_spend)));
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
  /**
   * The capability the job bought; one of the policy's
   * `allowed_endpoint_categories`. Undefined when it is not known, as it is
   * not for a job found on the chain after a restart (square#348): the spec
   * is hashed on chain, so the category is tried from the policy's list, in
   * order, until the prover stops naming `endpoint_category` as the rule
   * broken. The category that answered is in the outcome.
   */
  category: string | undefined;
  facts?: ReleaseFacts | undefined;
  signal?: AbortSignal | undefined;
  /**
   * Bind the proof even when the circuit marks the release non-compliant
   * (square#396). Since square#382 a job with no proof does not settle, so the
   * mandate's refusal has to reach the chain to end the escrow: the module
   * refuses the bound proof at release and the net returns to the client.
   * Off by default; the duty sets it once a refusal is the mandate's last
   * word on the job.
   */
  bindRefusal?: boolean | undefined;
}

export type BindOutcome =
  | { bound: true; proof: Hex; transaction: Hex; facts: ReleaseFacts; category: string; verdict: "compliant" }
  | { bound: true; proof: Hex; transaction: Hex; facts: ReleaseFacts; category: string; verdict: "refusal"; violated: ViolatedRule[] | null }
  | { bound: false; reason: "not-compliant"; violated: ViolatedRule[] | null; facts: ReleaseFacts; category: string }
  | { bound: false; reason: "policy-not-committed" | "policy-differs" | "policy-pinned" | "not-this-client" | "module-refuses" | "terminal"; detail: string; facts: ReleaseFacts };

/**
 * Build the proof for this job's release as it stands now, and bind it.
 *
 * Refuses before proving when the chain holds no commitment for the client
 * or a different one from this policy's (a proof under the wrong commitment
 * is refused at release, so it is refused here, before the prover's seconds
 * and the transaction's gas); when the job was funded under a commitment the
 * client has since replaced, the refusal names the pin and the older file
 * that proves against it. A proof the circuit marks non-compliant is
 * reported and not bound unless `bindRefusal` says so: since square#382 a job
 * with no proof holds its escrow, and binding the refusal is how the mandate's
 * answer settles it (the module refuses it at release and the net returns to
 * the client). The module's own `previewRelease` is asked last for a
 * compliant proof, so one the module would refuse for a reason this code did
 * not foresee never reaches the job.
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
    if (facts.pinnedCommitment !== null && commitment.hex.toLowerCase() === facts.liveCommitment.toLowerCase()) {
      return {
        bound: false,
        reason: "policy-pinned",
        detail: `job ${jobId} was funded under commitment ${facts.pinnedCommitment} and is proved against it; this policy is the one committed since (${commitment.hex}). Prove with the policy file that computes the pinned commitment (square policy prove --file <older file>)`,
        facts,
      };
    }
    return { bound: false, reason: "policy-differs", detail: `the chain holds commitment ${facts.commitment}, this policy computes ${commitment.hex}`, facts };
  }
  const payment = { recipient: facts.payee, amount: facts.amount, token: facts.token, dailySpentBefore: facts.dailySpentBefore, timestamp: facts.now };
  // A known category is asked once. An unknown one is looked for in the
  // policy's list: the first the prover does not refuse as the category is
  // the job's, and a refusal for any other rule is the answer for the job,
  // whichever category it names. A policy of one category costs one proof.
  const candidates = options.category !== undefined ? [options.category] : policy.allowed_endpoint_categories;
  let category = candidates[0] ?? "";
  let response = await prover.prove(proveRequest(policy, { ...payment, category }), { signal: options.signal });
  for (let i = 1; i < candidates.length && onlyTheCategoryFailed(response); i += 1) {
    category = candidates[i]!;
    response = await prover.prove(proveRequest(policy, { ...payment, category }), { signal: options.signal });
  }
  if (!response.is_compliant) {
    if (options.bindRefusal !== true) return { bound: false, reason: "not-compliant", violated: response.violated_rules, facts, category };
    // The mandate's no, put on the chain so the module can pronounce it: no
    // preview, since the preview would say what is being bound on purpose.
    const refusal = encodeComplianceProof(response.solidity);
    const bound = await client.setComplianceProof(jobId, refusal);
    return { bound: true, proof: refusal, transaction: bound.hash, facts, category, verdict: "refusal", violated: response.violated_rules };
  }
  const proof = encodeComplianceProof(response.solidity);
  const preview = await client.previewRelease({ jobId, payee: facts.payee, amount: facts.amount, client: facts.client, proof });
  if (preview === false) {
    return { bound: false, reason: "module-refuses", detail: "the installed module refuses a proof the circuit accepted: the module's verifier is keyed to another proving key than these artifacts, or the release moved between the read and the preview", facts };
  }
  const result = await client.setComplianceProof(jobId, proof);
  return { bound: true, proof, transaction: result.hash, facts, category, verdict: "compliant" };
}

function onlyTheCategoryFailed(response: { is_compliant: boolean; violated_rules: ViolatedRule[] | null }): boolean {
  return !response.is_compliant && response.violated_rules !== null && response.violated_rules.length === 1 && response.violated_rules[0] === "endpoint_category";
}

/** What the module said when a job was released, read from the receipt. */
/**
 * What the hook's screening said to the release the receipt carries
 * (square#35): the payee it checked and whether it was cleared, or null when
 * the hook screened nobody. Read from `ScreeningChecked`, which the hook
 * emits at release only while it holds a registry.
 */
export function screeningVerdict(receipt: TransactionReceipt, hook: Address): { payee: Address; cleared: boolean } | null {
  const logs = parseEventLogs({ abi: squareHookAbi, logs: receipt.logs, eventName: "ScreeningChecked" });
  for (const log of logs) {
    if (!isAddressEqual(log.address, hook)) continue;
    return { payee: log.args.payee, cleared: log.args.cleared };
  }
  return null;
}

export function moduleVerdict(receipt: TransactionReceipt, module: Address): { verified: boolean; reason?: Hex } | null {
  const logs = parseEventLogs({ abi: complianceModuleAbi, logs: receipt.logs });
  for (const log of logs) {
    if (!isAddressEqual(log.address, module)) continue;
    if (log.eventName === "ReleaseVerified") return { verified: true };
    if (log.eventName === "ReleaseRefused") return { verified: false, reason: log.args.reason };
  }
  return null;
}
