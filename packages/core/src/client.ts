import {
  type Abi,
  type Account,
  type Address,
  BaseError,
  type Chain,
  type ContractFunctionArgs,
  type ContractFunctionName,
  ContractFunctionRevertedError,
  type Hex,
  isAddressEqual,
  type PublicClient,
  type ReadContractReturnType,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import { arbitrationAbi, claimMarketAbi, erc20Abi, keeperEvaluatorAbi, squareHookAbi, squareJobAbi } from "./abi/index.js";
import { agentFromDid, type AgentReference } from "./agent.js";
import { deploymentFor, type SquareDeployment } from "./deployments.js";
import { decodeSquareLogs, eventsNamed, type SquareEvent } from "./events.js";
import { encodeCompleteOptParams, encodeSubmitOptParams, ZERO_HASH } from "./optParams.js";
import { type OutcomeValue } from "./reasons.js";
import { withSquareErrors } from "./revertAbi.js";
import { specDescription } from "./spec.js";

export const JobStatus = {
  Open: 0,
  Funded: 1,
  Submitted: 2,
  Completed: 3,
  Rejected: 4,
  Expired: 5,
} as const;

export type JobStatusValue = (typeof JobStatus)[keyof typeof JobStatus];

export type SquareWalletClient = WalletClient<Transport, Chain | undefined, Account>;

export interface SquareClientConfig {
  publicClient: PublicClient;
  walletClient?: SquareWalletClient;
  deployment?: SquareDeployment;
}

export interface TransactionResult {
  hash: Hex;
  receipt: TransactionReceipt;
  events: SquareEvent[];
}

export interface CreateJobParams {
  provider: Address;
  evaluator?: Address;
  expiredAt: bigint;
  description?: string;
  spec?: unknown;
  hook?: Address;
}

export interface SubmitParams {
  jobId: bigint;
  deliverable: Hex;
  agentId?: bigint;
  did?: string;
  validationRequestHash?: Hex;
}

export class WalletRequiredError extends Error {
  constructor() {
    super("this operation sends a transaction and needs a walletClient with an account");
    this.name = "WalletRequiredError";
  }
}

export class EventNotFoundError extends Error {
  constructor(eventName: string) {
    super(`the transaction was mined but emitted no ${eventName} event`);
    this.name = "EventNotFoundError";
  }
}

export class TransactionRevertedError extends Error {
  constructor(
    readonly hash: Hex,
    readonly receipt: TransactionReceipt,
  ) {
    super(`transaction ${hash} was mined in block ${receipt.blockNumber} and reverted, so it changed nothing`);
    this.name = "TransactionRevertedError";
  }
}

/**
 * The deployment and the chain disagree. `source` says which chain id lost:
 * `"declared"` is the id the viem client was built with, checked in the
 * constructor; `"endpoint"` is the id the RPC actually answered, checked on the
 * first read or write. They can differ, and only the second can catch an
 * endpoint that points at some other chain (#269).
 */
export class DeploymentChainMismatchError extends Error {
  constructor(
    readonly deploymentChainId: number,
    readonly clientChainId: number,
    readonly source: "declared" | "endpoint" = "declared",
  ) {
    super(
      source === "endpoint"
        ? `the deployment is for chain ${deploymentChainId} but the RPC endpoint answers eth_chainId with ${clientChainId}`
        : `the deployment is for chain ${deploymentChainId} but the client declares chain ${clientChainId}`,
    );
    this.name = "DeploymentChainMismatchError";
  }
}

export class DidScopeMismatchError extends Error {
  constructor(
    readonly did: string,
    readonly reference: AgentReference,
    readonly deployment: SquareDeployment,
  ) {
    super(
      `${did} is scoped to chain ${reference.chainId} registry ${reference.registry}, ` +
        `but this client settles on chain ${deployment.chainId} registry ${deployment.identityRegistry}`,
    );
    this.name = "DidScopeMismatchError";
  }
}

export class AgentIdMismatchError extends Error {
  constructor(
    readonly agentId: bigint,
    readonly didAgentId: bigint,
  ) {
    super(`agentId ${agentId} was passed alongside a did that names agent ${didAgentId}`);
    this.name = "AgentIdMismatchError";
  }
}

type WriteArgs<TAbi extends Abi, TName extends ContractFunctionName<TAbi, "nonpayable" | "payable">> = {
  abi: TAbi;
  address: Address;
  functionName: TName;
  args: ContractFunctionArgs<TAbi, "nonpayable" | "payable", TName>;
};

type ReadArgs<TAbi extends Abi, TName extends ContractFunctionName<TAbi, "pure" | "view">> = {
  abi: TAbi;
  address: Address;
  functionName: TName;
  args?: ContractFunctionArgs<TAbi, "pure" | "view", TName>;
};

/**
 * A call that reverted carrying nothing: no error data, no reason string.
 * Solidity's dispatcher answers an unknown selector exactly so, which is how
 * a contract deployed before a function existed looks from here.
 */
function isUnknownSelectorRevert(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  const reverted = error.walk((candidate) => candidate instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError && reverted.data === undefined && reverted.signature === undefined;
}

export class SquareClient {
  readonly publicClient: PublicClient;
  readonly walletClient: SquareWalletClient | undefined;
  readonly deployment: SquareDeployment;

  constructor(config: SquareClientConfig) {
    this.publicClient = config.publicClient;
    this.walletClient = config.walletClient;
    this.deployment = config.deployment ?? deploymentFor(this.chainIdOf(config));
    this.assertClientsAreOnDeploymentChain(config);
  }

  private declaredChainId(config: SquareClientConfig): number | undefined {
    return config.publicClient.chain?.id ?? config.walletClient?.chain?.id;
  }

  private chainIdOf(config: SquareClientConfig): number {
    const chainId = this.declaredChainId(config);
    if (chainId === undefined) {
      throw new Error("pass a deployment explicitly when the clients carry no chain");
    }
    return chainId;
  }

  private assertClientsAreOnDeploymentChain(config: SquareClientConfig): void {
    for (const chainId of [config.publicClient.chain?.id, config.walletClient?.chain?.id]) {
      if (chainId !== undefined && chainId !== this.deployment.chainId) {
        throw new DeploymentChainMismatchError(this.deployment.chainId, chainId);
      }
    }
  }

  get account(): Address {
    return this.wallet().account.address;
  }

  private wallet(): SquareWalletClient {
    if (!this.walletClient) throw new WalletRequiredError();
    return this.walletClient;
  }

  private endpointChain: Promise<void> | undefined;

  /**
   * Ask the endpoint which chain it is, once, and refuse to go on if it is not
   * the deployment's. The constructor compares the deployment to the chain the
   * clients *declare*, and both sides of that come from the caller, so it
   * cannot catch an `RPC_URL` that points somewhere else: every read would
   * answer from the wrong chain at Arc addresses, quietly, and a local-key
   * wallet would sign without viem ever checking either (#269). This is the
   * `cast chain-id` step `deploy-arc-testnet.sh` takes before broadcasting,
   * done for the SDK. Runs before the first read or write; a failure is not
   * cached, so a transport error on the check is retried on the next call.
   */
  async assertChain(): Promise<void> {
    this.endpointChain ??= this.publicClient.getChainId().then((actual) => {
      if (actual !== this.deployment.chainId) {
        throw new DeploymentChainMismatchError(this.deployment.chainId, actual, "endpoint");
      }
    });
    try {
      await this.endpointChain;
    } catch (error) {
      this.endpointChain = undefined;
      throw error;
    }
  }

  /**
   * Every read goes through here so two things hold for all of them: the
   * endpoint has been checked against the deployment, and a revert decodes
   * to a name whichever Square contract raised it (see `revertAbi.ts`).
   */
  private async read<TAbi extends Abi, TName extends ContractFunctionName<TAbi, "pure" | "view">>(
    request: ReadArgs<TAbi, TName>,
  ): Promise<ReadContractReturnType<TAbi, TName, ContractFunctionArgs<TAbi, "pure" | "view", TName>>> {
    await this.assertChain();
    return this.publicClient.readContract({ ...request, abi: withSquareErrors(request.abi) } as never) as never;
  }

  private async write<TAbi extends Abi, TName extends ContractFunctionName<TAbi, "nonpayable" | "payable">>(
    request: WriteArgs<TAbi, TName>,
  ): Promise<TransactionResult> {
    await this.assertChain();
    const wallet = this.wallet();
    // The ABI carries every Square error so the simulation can name a revert
    // raised behind the contract being called. simulateContract hands back a
    // request whose ABI is cut down to the one function, so the full one is
    // put back for the send: the write leg carries the same error entries as
    // the simulation that approved it (#268).
    const abi = withSquareErrors(request.abi);
    const simulation = await this.publicClient.simulateContract({
      ...request,
      abi,
      account: wallet.account,
    } as never);
    const hash = await wallet.writeContract({ ...simulation.request, abi } as never);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new TransactionRevertedError(hash, receipt);
    return { hash, receipt, events: decodeSquareLogs(receipt.logs, this.deployment) };
  }

  decodeReceipt(receipt: TransactionReceipt): SquareEvent[] {
    return decodeSquareLogs(receipt.logs, this.deployment);
  }

  async jobCounter(): Promise<bigint> {
    return this.read({
      abi: squareJobAbi,
      address: this.deployment.squareJob,
      functionName: "jobCounter",
    });
  }

  async getJob(jobId: bigint) {
    return this.read({
      abi: squareJobAbi,
      address: this.deployment.squareJob,
      functionName: "getJob",
      args: [jobId],
    });
  }

  async getJobRecord(jobId: bigint) {
    return this.read({
      abi: squareJobAbi,
      address: this.deployment.squareJob,
      functionName: "getJobRecord",
      args: [jobId],
    });
  }

  async netPayout(jobId: bigint): Promise<bigint> {
    return this.read({
      abi: squareJobAbi,
      address: this.deployment.squareJob,
      functionName: "netPayout",
      args: [jobId],
    });
  }

  async withdrawable(account: Address): Promise<bigint> {
    return this.read({
      abi: squareJobAbi,
      address: this.deployment.squareJob,
      functionName: "withdrawable",
      args: [account],
    });
  }

  async bondWithdrawable(account: Address): Promise<bigint> {
    return this.read({
      abi: arbitrationAbi,
      address: this.deployment.arbitration,
      functionName: "withdrawable",
      args: [account],
    });
  }

  async settlementHorizon(): Promise<number> {
    const horizon = await this.read({
      abi: keeperEvaluatorAbi,
      address: this.deployment.keeperEvaluator,
      functionName: "settlementHorizon",
    });
    return Number(horizon);
  }

  async challengeEndsAt(jobId: bigint): Promise<number> {
    const end = await this.read({
      abi: keeperEvaluatorAbi,
      address: this.deployment.keeperEvaluator,
      functionName: "challengeEndsAt",
      args: [jobId],
    });
    return Number(end);
  }

  async isDisputed(jobId: bigint): Promise<boolean> {
    return this.read({
      abi: keeperEvaluatorAbi,
      address: this.deployment.keeperEvaluator,
      functionName: "isDisputed",
      args: [jobId],
    });
  }

  async disputeOf(jobId: bigint) {
    return this.read({
      abi: arbitrationAbi,
      address: this.deployment.arbitration,
      functionName: "disputeOf",
      args: [jobId],
    });
  }

  async bondFor(budget: bigint): Promise<bigint> {
    return this.read({
      abi: arbitrationAbi,
      address: this.deployment.arbitration,
      functionName: "bondFor",
      args: [budget],
    });
  }

  async listing(jobId: bigint) {
    return this.read({
      abi: claimMarketAbi,
      address: this.deployment.claimMarket,
      functionName: "getListing",
      args: [jobId],
    });
  }

  async payeeOf(jobId: bigint): Promise<Address> {
    return this.read({
      abi: claimMarketAbi,
      address: this.deployment.claimMarket,
      functionName: "payeeOf",
      args: [jobId],
    });
  }

  /**
   * Whether the hook answers `boundAgentOf`. Decided once per client, on the
   * first `agentOf()`: a hook deployed before #300 has no such selector and
   * the call reverts with no data, which is the one shape taken to mean
   * "older hook"; anything else is an error and is thrown.
   */
  private hookAnswersBoundAgentOf: boolean | undefined;

  /**
   * The ERC-8004 agent a job's submit bound, or null when none was.
   *
   * Agent id 0 is a real agent (on Arc's registry it is the first
   * registration), so 0 cannot stand for "none": the hook's `agentOf` reverts
   * with NoAgentBound when nothing is bound and `boundAgentOf` answers both
   * questions, and this reads the latter. On a hook deployed before #300 only
   * `agentOf` exists and answers 0 for both; that is read as null, which is
   * what it meant there and is wrong only for agent 0.
   */
  async agentOf(jobId: bigint): Promise<bigint | null> {
    if (this.hookAnswersBoundAgentOf !== false) {
      try {
        const [bound, agentId] = await this.read({
          abi: squareHookAbi,
          address: this.deployment.squareHook,
          functionName: "boundAgentOf",
          args: [jobId],
        });
        this.hookAnswersBoundAgentOf = true;
        return bound ? agentId : null;
      } catch (error) {
        if (!isUnknownSelectorRevert(error)) throw error;
        this.hookAnswersBoundAgentOf = false;
      }
    }
    const agentId = await this.read({
      abi: squareHookAbi,
      address: this.deployment.squareHook,
      functionName: "agentOf",
      args: [jobId],
    });
    return agentId === 0n ? null : agentId;
  }

  async usdcBalance(account: Address): Promise<bigint> {
    return this.read({
      abi: erc20Abi,
      address: this.deployment.usdc,
      functionName: "balanceOf",
      args: [account],
    });
  }

  async usdcAllowance(owner: Address, spender: Address): Promise<bigint> {
    return this.read({
      abi: erc20Abi,
      address: this.deployment.usdc,
      functionName: "allowance",
      args: [owner, spender],
    });
  }

  async approveUsdc(spender: Address, amount: bigint): Promise<TransactionResult> {
    return this.write({ abi: erc20Abi, address: this.deployment.usdc, functionName: "approve", args: [spender, amount] });
  }

  private async ensureAllowance(spender: Address, amount: bigint): Promise<void> {
    const current = await this.usdcAllowance(this.account, spender);
    if (current < amount) await this.approveUsdc(spender, amount);
  }

  async createJob(params: CreateJobParams): Promise<TransactionResult & { jobId: bigint }> {
    const description = params.spec !== undefined ? specDescription(params.spec) : (params.description ?? "");
    const result = await this.write({
      abi: squareJobAbi,
      address: this.deployment.squareJob,
      functionName: "createJob",
      args: [
        params.provider,
        params.evaluator ?? this.deployment.keeperEvaluator,
        params.expiredAt,
        description,
        params.hook ?? this.deployment.squareHook,
      ],
    });
    const created = eventsNamed(result.events, "JobCreated")[0];
    if (!created) throw new EventNotFoundError("JobCreated");
    return { ...result, jobId: created.args.jobId };
  }

  async setProvider(jobId: bigint, provider: Address, optParams: Hex = "0x"): Promise<TransactionResult> {
    return this.write({
      abi: squareJobAbi,
      address: this.deployment.squareJob,
      functionName: "setProvider",
      args: [jobId, provider, optParams],
    });
  }

  async setBudget(jobId: bigint, amount: bigint, optParams: Hex = "0x"): Promise<TransactionResult> {
    return this.write({
      abi: squareJobAbi,
      address: this.deployment.squareJob,
      functionName: "setBudget",
      args: [jobId, amount, optParams],
    });
  }

  async fund(jobId: bigint, expectedBudget: bigint, options: { autoApprove?: boolean; optParams?: Hex } = {}) {
    if (options.autoApprove ?? true) await this.ensureAllowance(this.deployment.squareJob, expectedBudget);
    return this.write({
      abi: squareJobAbi,
      address: this.deployment.squareJob,
      functionName: "fund",
      args: [jobId, expectedBudget, options.optParams ?? "0x"],
    });
  }

  private agentIdFor(params: SubmitParams): bigint | undefined {
    if (params.did === undefined) return params.agentId;
    const reference = agentFromDid(params.did);
    if (reference.chainId !== this.deployment.chainId || !isAddressEqual(reference.registry, this.deployment.identityRegistry)) {
      throw new DidScopeMismatchError(params.did, reference, this.deployment);
    }
    if (params.agentId !== undefined && params.agentId !== reference.agentId) {
      throw new AgentIdMismatchError(params.agentId, reference.agentId);
    }
    return reference.agentId;
  }

  async submit(params: SubmitParams): Promise<TransactionResult> {
    const agentId = this.agentIdFor(params);
    const optParams =
      agentId === undefined
        ? "0x"
        : encodeSubmitOptParams({ agentId, validationRequestHash: params.validationRequestHash ?? ZERO_HASH });
    return this.write({
      abi: squareJobAbi,
      address: this.deployment.squareJob,
      functionName: "submit",
      args: [params.jobId, params.deliverable, optParams],
    });
  }

  async complete(jobId: bigint, reason: Hex, optParams: Hex = "0x"): Promise<TransactionResult> {
    return this.write({
      abi: squareJobAbi,
      address: this.deployment.squareJob,
      functionName: "complete",
      args: [jobId, reason, optParams],
    });
  }

  async reject(jobId: bigint, reason: Hex = ZERO_HASH, optParams: Hex = "0x"): Promise<TransactionResult> {
    return this.write({
      abi: squareJobAbi,
      address: this.deployment.squareJob,
      functionName: "reject",
      args: [jobId, reason, optParams],
    });
  }

  async claimRefund(jobId: bigint): Promise<TransactionResult> {
    return this.write({
      abi: squareJobAbi,
      address: this.deployment.squareJob,
      functionName: "claimRefund",
      args: [jobId],
    });
  }

  async withdraw(): Promise<TransactionResult> {
    return this.write({ abi: squareJobAbi, address: this.deployment.squareJob, functionName: "withdraw", args: [] });
  }

  async withdrawTo(to: Address, amount: bigint): Promise<TransactionResult> {
    return this.write({
      abi: squareJobAbi,
      address: this.deployment.squareJob,
      functionName: "withdrawTo",
      args: [to, amount],
    });
  }

  async finalize(jobId: bigint, complianceProof: Hex = "0x"): Promise<TransactionResult> {
    return this.write({
      abi: keeperEvaluatorAbi,
      address: this.deployment.keeperEvaluator,
      functionName: "finalize",
      args: [jobId, complianceProof],
    });
  }

  async finalizeDecided(jobId: bigint, complianceProof: Hex = "0x"): Promise<TransactionResult> {
    return this.write({
      abi: keeperEvaluatorAbi,
      address: this.deployment.keeperEvaluator,
      functionName: "finalizeDecided",
      args: [jobId, complianceProof],
    });
  }

  async dispute(jobId: bigint, evidence: Hex = ZERO_HASH, options: { autoApproveBond?: boolean } = {}) {
    if (options.autoApproveBond ?? true) {
      const job = await this.getJobRecord(jobId);
      const bond = await this.bondFor(job.budget);
      await this.ensureAllowance(this.deployment.arbitration, bond);
    }
    return this.write({
      abi: keeperEvaluatorAbi,
      address: this.deployment.keeperEvaluator,
      functionName: "dispute",
      args: [jobId, evidence],
    });
  }

  async vote(jobId: bigint, outcome: OutcomeValue, providerBps: number): Promise<TransactionResult> {
    return this.write({
      abi: arbitrationAbi,
      address: this.deployment.arbitration,
      functionName: "vote",
      args: [jobId, outcome, providerBps],
    });
  }

  async lapse(jobId: bigint): Promise<TransactionResult> {
    return this.write({ abi: arbitrationAbi, address: this.deployment.arbitration, functionName: "lapse", args: [jobId] });
  }

  async withdrawBond(): Promise<TransactionResult> {
    return this.write({ abi: arbitrationAbi, address: this.deployment.arbitration, functionName: "withdraw", args: [] });
  }

  async listClaim(jobId: bigint, price: bigint): Promise<TransactionResult> {
    return this.write({
      abi: claimMarketAbi,
      address: this.deployment.claimMarket,
      functionName: "list",
      args: [jobId, price],
    });
  }

  async buyClaim(jobId: bigint, options: { autoApprove?: boolean; expectedPrice?: bigint } = {}): Promise<TransactionResult> {
    const listing = await this.listing(jobId);
    const expectedPrice = options.expectedPrice ?? listing.price;
    if (options.autoApprove ?? true) await this.ensureAllowance(this.deployment.claimMarket, expectedPrice);
    return this.write({
      abi: claimMarketAbi,
      address: this.deployment.claimMarket,
      functionName: "buy",
      args: [jobId, expectedPrice],
    });
  }

  async cancelClaim(jobId: bigint): Promise<TransactionResult> {
    return this.write({ abi: claimMarketAbi, address: this.deployment.claimMarket, functionName: "cancel", args: [jobId] });
  }

  async recordExpiry(jobId: bigint): Promise<TransactionResult> {
    return this.write({
      abi: squareHookAbi,
      address: this.deployment.squareHook,
      functionName: "recordExpiry",
      args: [jobId],
    });
  }

  completeOptParams(params: Parameters<typeof encodeCompleteOptParams>[0]): Hex {
    return encodeCompleteOptParams(params);
  }
}

export function createSquareClient(config: SquareClientConfig): SquareClient {
  return new SquareClient(config);
}

/**
 * `createSquareClient`, then the endpoint check, before the client is handed
 * back. The check runs on first use either way; this is for a caller that
 * wants a misconfigured `RPC_URL` to fail at startup rather than on the first
 * request it serves.
 */
export async function connectSquareClient(config: SquareClientConfig): Promise<SquareClient> {
  const client = new SquareClient(config);
  await client.assertChain();
  return client;
}
