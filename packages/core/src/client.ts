import {
  type Abi,
  type Account,
  type Address,
  type Chain,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import { arbitrationAbi, claimMarketAbi, erc20Abi, keeperEvaluatorAbi, squareHookAbi, squareJobAbi } from "./abi/index.js";
import { agentFromDid } from "./agent.js";
import { deploymentFor, type SquareDeployment } from "./deployments.js";
import { decodeSquareLogs, eventsNamed, type SquareEvent } from "./events.js";
import { encodeCompleteOptParams, encodeSubmitOptParams, ZERO_HASH } from "./optParams.js";
import { type OutcomeValue } from "./reasons.js";
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

type WriteArgs<TAbi extends Abi, TName extends ContractFunctionName<TAbi, "nonpayable" | "payable">> = {
  abi: TAbi;
  address: Address;
  functionName: TName;
  args: ContractFunctionArgs<TAbi, "nonpayable" | "payable", TName>;
};

export class SquareClient {
  readonly publicClient: PublicClient;
  readonly walletClient: SquareWalletClient | undefined;
  readonly deployment: SquareDeployment;

  constructor(config: SquareClientConfig) {
    this.publicClient = config.publicClient;
    this.walletClient = config.walletClient;
    this.deployment = config.deployment ?? deploymentFor(this.chainIdOf(config));
  }

  private chainIdOf(config: SquareClientConfig): number {
    const chainId = config.publicClient.chain?.id ?? config.walletClient?.chain?.id;
    if (chainId === undefined) {
      throw new Error("pass a deployment explicitly when the clients carry no chain");
    }
    return chainId;
  }

  get account(): Address {
    return this.wallet().account.address;
  }

  private wallet(): SquareWalletClient {
    if (!this.walletClient) throw new WalletRequiredError();
    return this.walletClient;
  }

  private async write<TAbi extends Abi, TName extends ContractFunctionName<TAbi, "nonpayable" | "payable">>(
    request: WriteArgs<TAbi, TName>,
  ): Promise<TransactionResult> {
    const wallet = this.wallet();
    const simulation = await this.publicClient.simulateContract({
      ...request,
      account: wallet.account,
    } as never);
    const hash = await wallet.writeContract(simulation.request as never);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    return { hash, receipt, events: decodeSquareLogs(receipt.logs, this.deployment) };
  }

  decodeReceipt(receipt: TransactionReceipt): SquareEvent[] {
    return decodeSquareLogs(receipt.logs, this.deployment);
  }

  async jobCounter(): Promise<bigint> {
    return this.publicClient.readContract({
      abi: squareJobAbi,
      address: this.deployment.squareJob,
      functionName: "jobCounter",
    });
  }

  async getJob(jobId: bigint) {
    return this.publicClient.readContract({
      abi: squareJobAbi,
      address: this.deployment.squareJob,
      functionName: "getJob",
      args: [jobId],
    });
  }

  async getJobRecord(jobId: bigint) {
    return this.publicClient.readContract({
      abi: squareJobAbi,
      address: this.deployment.squareJob,
      functionName: "getJobRecord",
      args: [jobId],
    });
  }

  async netPayout(jobId: bigint): Promise<bigint> {
    return this.publicClient.readContract({
      abi: squareJobAbi,
      address: this.deployment.squareJob,
      functionName: "netPayout",
      args: [jobId],
    });
  }

  async withdrawable(account: Address): Promise<bigint> {
    return this.publicClient.readContract({
      abi: squareJobAbi,
      address: this.deployment.squareJob,
      functionName: "withdrawable",
      args: [account],
    });
  }

  async bondWithdrawable(account: Address): Promise<bigint> {
    return this.publicClient.readContract({
      abi: arbitrationAbi,
      address: this.deployment.arbitration,
      functionName: "withdrawable",
      args: [account],
    });
  }

  async settlementHorizon(): Promise<number> {
    const horizon = await this.publicClient.readContract({
      abi: keeperEvaluatorAbi,
      address: this.deployment.keeperEvaluator,
      functionName: "settlementHorizon",
    });
    return Number(horizon);
  }

  async challengeEndsAt(jobId: bigint): Promise<number> {
    const end = await this.publicClient.readContract({
      abi: keeperEvaluatorAbi,
      address: this.deployment.keeperEvaluator,
      functionName: "challengeEndsAt",
      args: [jobId],
    });
    return Number(end);
  }

  async isDisputed(jobId: bigint): Promise<boolean> {
    return this.publicClient.readContract({
      abi: keeperEvaluatorAbi,
      address: this.deployment.keeperEvaluator,
      functionName: "isDisputed",
      args: [jobId],
    });
  }

  async disputeOf(jobId: bigint) {
    return this.publicClient.readContract({
      abi: arbitrationAbi,
      address: this.deployment.arbitration,
      functionName: "disputeOf",
      args: [jobId],
    });
  }

  async bondFor(budget: bigint): Promise<bigint> {
    return this.publicClient.readContract({
      abi: arbitrationAbi,
      address: this.deployment.arbitration,
      functionName: "bondFor",
      args: [budget],
    });
  }

  async listing(jobId: bigint) {
    return this.publicClient.readContract({
      abi: claimMarketAbi,
      address: this.deployment.claimMarket,
      functionName: "getListing",
      args: [jobId],
    });
  }

  async payeeOf(jobId: bigint): Promise<Address> {
    return this.publicClient.readContract({
      abi: claimMarketAbi,
      address: this.deployment.claimMarket,
      functionName: "payeeOf",
      args: [jobId],
    });
  }

  async agentOf(jobId: bigint): Promise<bigint> {
    return this.publicClient.readContract({
      abi: squareHookAbi,
      address: this.deployment.squareHook,
      functionName: "agentOf",
      args: [jobId],
    });
  }

  async usdcBalance(account: Address): Promise<bigint> {
    return this.publicClient.readContract({
      abi: erc20Abi,
      address: this.deployment.usdc,
      functionName: "balanceOf",
      args: [account],
    });
  }

  async usdcAllowance(owner: Address, spender: Address): Promise<bigint> {
    return this.publicClient.readContract({
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

  async submit(params: SubmitParams): Promise<TransactionResult> {
    const agentId = params.agentId ?? (params.did ? agentFromDid(params.did).agentId : undefined);
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

  async buyClaim(jobId: bigint, options: { autoApprove?: boolean } = {}): Promise<TransactionResult> {
    if (options.autoApprove ?? true) {
      const listing = await this.listing(jobId);
      await this.ensureAllowance(this.deployment.claimMarket, listing.price);
    }
    return this.write({ abi: claimMarketAbi, address: this.deployment.claimMarket, functionName: "buy", args: [jobId] });
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
