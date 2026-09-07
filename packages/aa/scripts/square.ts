import {
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import type { SquareDeployment } from "./fork.js";

export const squareJobAbi = parseAbi([
  "struct JobRecord { address client; uint48 createdAt; uint48 expiredAt; address provider; uint48 fundedAt; uint48 submittedAt; address evaluator; uint64 budget; uint8 status; address hook; uint16 platformFeeBP; uint16 evaluatorFeeBP; uint16 providerBps; bool hookResolvesPayout; address payee; bytes32 deliverable; string description; }",
  "function createJob(address provider, address evaluator, uint256 expiredAt, string description, address hook) returns (uint256 jobId)",
  "function setBudget(uint256 jobId, uint256 amount, bytes optParams)",
  "function fund(uint256 jobId, uint256 expectedBudget, bytes optParams)",
  "function submit(uint256 jobId, bytes32 deliverable, bytes optParams)",
  "function getJobRecord(uint256 jobId) view returns (JobRecord)",
  "function jobCounter() view returns (uint256)",
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook)",
  "error InvalidJob()",
  "error WrongStatus()",
  "error Unauthorized()",
  "error ZeroBudget()",
  "error BudgetMismatch()",
  "error BudgetTooLarge()",
  "error ProviderNotSet()",
  "error PastExpiry()",
  "error ExpiryTooShort(uint256 earliestAllowed)",
]);

export const JobStatus = {
  Open: 0,
  Funded: 1,
  Submitted: 2,
  Completed: 3,
  Rejected: 4,
  Expired: 5,
} as const;

export type Actor = WalletClient<Transport, Chain, Account>;

export type SquareEnv = {
  publicClient: PublicClient<Transport, Chain>;
  deployment: SquareDeployment;
};

export type FeeOptions = {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

export const THIRTY_DAYS = 30n * 24n * 3600n;

export function encodeSetBudget(jobId: bigint, amount: bigint, optParams: Hex = "0x"): Hex {
  return encodeFunctionData({ abi: squareJobAbi, functionName: "setBudget", args: [jobId, amount, optParams] });
}

export function encodeSubmit(jobId: bigint, deliverable: Hex, optParams: Hex = "0x"): Hex {
  return encodeFunctionData({ abi: squareJobAbi, functionName: "submit", args: [jobId, deliverable, optParams] });
}

export async function createJob(
  env: SquareEnv,
  client: Actor,
  provider: Address,
  description = "spec:test",
): Promise<bigint> {
  const latest = await env.publicClient.getBlock();
  const hash = await client.writeContract({
    address: env.deployment.SquareJob,
    abi: squareJobAbi,
    functionName: "createJob",
    args: [provider, env.deployment.KeeperEvaluator, latest.timestamp + THIRTY_DAYS, description, env.deployment.SquareHook],
  });
  const receipt = await env.publicClient.waitForTransactionReceipt({ hash });
  const [created] = parseEventLogs({ abi: squareJobAbi, eventName: "JobCreated", logs: receipt.logs });
  if (!created) throw new Error(`createJob transaction ${hash} emitted no JobCreated`);
  return created.args.jobId;
}

export async function setBudgetAsEoa(
  env: SquareEnv,
  actor: Actor,
  jobId: bigint,
  amount: bigint,
  fees?: FeeOptions,
): Promise<TransactionReceipt> {
  const hash = await actor.writeContract({
    address: env.deployment.SquareJob,
    abi: squareJobAbi,
    functionName: "setBudget",
    args: [jobId, amount, "0x"],
    ...fees,
  });
  return env.publicClient.waitForTransactionReceipt({ hash });
}

export async function submitAsEoa(
  env: SquareEnv,
  actor: Actor,
  jobId: bigint,
  deliverable: Hex,
  fees?: FeeOptions,
): Promise<TransactionReceipt> {
  const hash = await actor.writeContract({
    address: env.deployment.SquareJob,
    abi: squareJobAbi,
    functionName: "submit",
    args: [jobId, deliverable, "0x"],
    ...fees,
  });
  return env.publicClient.waitForTransactionReceipt({ hash });
}

export async function fundJob(env: SquareEnv, client: Actor, jobId: bigint, budget: bigint): Promise<TransactionReceipt> {
  const approval = await client.writeContract({
    address: env.deployment.USDC,
    abi: erc20Abi,
    functionName: "approve",
    args: [env.deployment.SquareJob, budget],
  });
  await env.publicClient.waitForTransactionReceipt({ hash: approval });
  const hash = await client.writeContract({
    address: env.deployment.SquareJob,
    abi: squareJobAbi,
    functionName: "fund",
    args: [jobId, budget, "0x"],
  });
  return env.publicClient.waitForTransactionReceipt({ hash });
}

export async function readJob(env: SquareEnv, jobId: bigint) {
  return env.publicClient.readContract({
    address: env.deployment.SquareJob,
    abi: squareJobAbi,
    functionName: "getJobRecord",
    args: [jobId],
  });
}
