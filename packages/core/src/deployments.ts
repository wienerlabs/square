import { getAddress, isAddress, type Address } from "viem";

export interface SquareDeployment {
  chainId: number;
  squareJob: Address;
  keeperEvaluator: Address;
  arbitration: Address;
  claimMarket: Address;
  squareHook: Address;
  usdc: Address;
  identityRegistry: Address;
  reputationRegistry: Address;
  validationRegistry: Address;
}

export const ARC_TESTNET_CHAIN_ID = 5042002;
export const ANVIL_CHAIN_ID = 31337;

export const ARC_TESTNET_RPC_URL = "https://rpc.testnet.arc.io";

export class UnknownDeploymentError extends Error {
  constructor(public readonly chainId: number) {
    super(`No Square deployment is known for chain ${chainId}`);
    this.name = "UnknownDeploymentError";
  }
}

export class InvalidDeploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDeploymentError";
  }
}

const localAnvil: SquareDeployment = {
  chainId: ANVIL_CHAIN_ID,
  usdc: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  identityRegistry: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  reputationRegistry: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
  validationRegistry: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
  squareJob: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
  keeperEvaluator: "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707",
  arbitration: "0x0165878A594ca255338adfa4d48449f69242Eb8F",
  claimMarket: "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
  squareHook: "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6",
};

export const deployments: Readonly<Record<number, SquareDeployment>> = {
  [ANVIL_CHAIN_ID]: localAnvil,
};

export function deploymentFor(chainId: number): SquareDeployment {
  const found = deployments[chainId];
  if (!found) throw new UnknownDeploymentError(chainId);
  return found;
}

const jsonKeys = {
  squareJob: "SquareJob",
  keeperEvaluator: "KeeperEvaluator",
  arbitration: "Arbitration",
  claimMarket: "ClaimMarket",
  squareHook: "SquareHook",
  usdc: "USDC",
  identityRegistry: "IdentityRegistry",
  reputationRegistry: "ReputationRegistry",
  validationRegistry: "ValidationRegistry",
} as const;

export function deploymentFromJson(json: unknown): SquareDeployment {
  if (typeof json !== "object" || json === null) throw new InvalidDeploymentError("deployment is not an object");
  const record = json as Record<string, unknown>;
  const chainId = Number(record["chainId"]);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new InvalidDeploymentError("chainId is missing");
  const out: Record<string, unknown> = { chainId };
  for (const [field, key] of Object.entries(jsonKeys)) {
    const value = record[key];
    if (typeof value !== "string" || !isAddress(value)) {
      throw new InvalidDeploymentError(`${key} is not an address`);
    }
    out[field] = getAddress(value);
  }
  return out as unknown as SquareDeployment;
}
