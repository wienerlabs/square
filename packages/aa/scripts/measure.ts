import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  keccak256,
  parseEther,
  parseUnits,
  toHex,
  type Address,
  type Hash,
  type TransactionReceipt,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSelfBundler, type SendUserOperationResult } from "../src/selfBundler.js";
import { toSimpleSmartAccount } from "../src/simpleAccount.js";
import { ARC_OBSERVED_GAS_PRICE_WEI, ENTRY_POINT_V07, SIMPLE_ACCOUNT_FACTORY_V07 } from "../src/constants.js";
import {
  anvilAccount,
  deploySquareStack,
  forkChain,
  fundNative,
  packageRoot,
  startAnvilFork,
  type SquareDeployment,
} from "./fork.js";
import {
  createJob,
  encodeSetBudget,
  encodeSubmit,
  fundJob,
  readJob,
  setBudgetAsEoa,
  submitAsEoa,
  JobStatus,
  type FeeOptions,
  type SquareEnv,
} from "./square.js";

export type MeasurementOperation = "setBudget" | "submit";

export type MeasurementPath = "eoa" | "userop-deployed" | "userop-deploying";

export type MeasurementRow = {
  operation: MeasurementOperation;
  path: MeasurementPath;
  txHash: Hash;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  actualGasUsed: bigint | null;
  actualGasCost: bigint | null;
  keeperNetWei: bigint | null;
};

export type MeasurementOverhead = {
  operation: MeasurementOperation;
  path: Exclude<MeasurementPath, "eoa">;
  gas: bigint;
  usdc: string;
};

export type Measurement = {
  chainId: number;
  forkBlock: bigint;
  entryPoint: Address;
  factory: Address;
  gasPriceWei: bigint;
  rows: MeasurementRow[];
  overhead: MeasurementOverhead[];
  measuredAt: string;
};

export type RunMeasurementParameters = {
  rpcUrl: string;
  deployment: SquareDeployment;
};

export const measurementsPath = join(packageRoot, "measurements.json");

export function usdcAtObservedPrice(gas: bigint, gasPriceWei = ARC_OBSERVED_GAS_PRICE_WEI): string {
  return formatUnits(gas * gasPriceWei, 18);
}

function eoaRow(operation: MeasurementOperation, receipt: TransactionReceipt): MeasurementRow {
  return {
    operation,
    path: "eoa",
    txHash: receipt.transactionHash,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    actualGasUsed: null,
    actualGasCost: null,
    keeperNetWei: null,
  };
}

function userOpRow(
  operation: MeasurementOperation,
  path: Exclude<MeasurementPath, "eoa">,
  result: SendUserOperationResult,
): MeasurementRow {
  if (!result.success) {
    throw new Error(`${operation} via ${path} was included but reverted: ${result.revertReason ?? "no reason"}`);
  }
  const { receipt } = result;
  return {
    operation,
    path,
    txHash: result.txHash,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    actualGasUsed: result.actualGasUsed,
    actualGasCost: result.actualGasCost,
    keeperNetWei: result.actualGasCost - receipt.gasUsed * receipt.effectiveGasPrice,
  };
}

export async function runMeasurement(parameters: RunMeasurementParameters): Promise<Measurement> {
  const { rpcUrl, deployment } = parameters;
  const publicClient = createPublicClient({ chain: forkChain, transport: http(rpcUrl), pollingInterval: 50 });
  const wallet = (account: ReturnType<typeof privateKeyToAccount>) =>
    createWalletClient({ chain: forkChain, transport: http(rpcUrl), account, pollingInterval: 50 });
  const client = wallet(anvilAccount(1));
  const providerEoa = wallet(anvilAccount(2));
  const keeper = wallet(privateKeyToAccount(generatePrivateKey()));
  const owner = privateKeyToAccount(generatePrivateKey());
  await fundNative(rpcUrl, [client.account.address, providerEoa.account.address, keeper.account.address]);

  const env: SquareEnv = { publicClient, deployment };
  const bundler = createSelfBundler({ walletClient: keeper, publicClient });
  const estimated = await publicClient.estimateFeesPerGas();
  const fees: FeeOptions = {
    maxFeePerGas: estimated.maxFeePerGas,
    maxPriorityFeePerGas: estimated.maxPriorityFeePerGas,
  };
  const budget = parseUnits("100", 6);
  const deliverable = keccak256(toHex("deliverable:measurement"));
  const kernel = deployment.SquareJob;
  const forkBlock = await publicClient.getBlockNumber();
  const rows: MeasurementRow[] = [];

  const jobA = await createJob(env, client, providerEoa.account.address, "spec:measure:eoa");
  rows.push(eoaRow("setBudget", await setBudgetAsEoa(env, providerEoa, jobA, budget, fees)));
  await fundJob(env, client, jobA, budget);
  rows.push(eoaRow("submit", await submitAsEoa(env, providerEoa, jobA, deliverable, fees)));

  const accountA = await toSimpleSmartAccount({ client: publicClient, owner, salt: 1n });
  await bundler.depositTo(accountA.address, parseEther("1"));
  const jobB = await createJob(env, client, accountA.address, "spec:measure:userop");
  rows.push(
    userOpRow(
      "setBudget",
      "userop-deploying",
      await bundler.sendUserOperation(accountA, [{ to: kernel, data: encodeSetBudget(jobB, budget) }], fees),
    ),
  );
  await fundJob(env, client, jobB, budget);
  rows.push(
    userOpRow(
      "submit",
      "userop-deployed",
      await bundler.sendUserOperation(accountA, [{ to: kernel, data: encodeSubmit(jobB, deliverable) }], fees),
    ),
  );
  const jobC = await createJob(env, client, accountA.address, "spec:measure:userop");
  rows.push(
    userOpRow(
      "setBudget",
      "userop-deployed",
      await bundler.sendUserOperation(accountA, [{ to: kernel, data: encodeSetBudget(jobC, budget) }], fees),
    ),
  );

  const accountB = await toSimpleSmartAccount({ client: publicClient, owner, salt: 2n });
  await bundler.depositTo(accountB.address, parseEther("1"));
  const jobD = await createJob(env, client, accountB.address, "spec:measure:userop");
  await setBudgetAsEoa(env, client, jobD, budget);
  await fundJob(env, client, jobD, budget);
  rows.push(
    userOpRow(
      "submit",
      "userop-deploying",
      await bundler.sendUserOperation(accountB, [{ to: kernel, data: encodeSubmit(jobD, deliverable) }], fees),
    ),
  );

  for (const jobId of [jobA, jobB, jobD]) {
    const record = await readJob(env, jobId);
    if (record.status !== JobStatus.Submitted) throw new Error(`job ${jobId} ended in status ${record.status}`);
  }

  const overhead: MeasurementOverhead[] = [];
  for (const operation of ["setBudget", "submit"] as const) {
    const baseline = rows.find((row) => row.operation === operation && row.path === "eoa");
    if (!baseline) throw new Error(`no EOA baseline for ${operation}`);
    for (const path of ["userop-deployed", "userop-deploying"] as const) {
      const row = rows.find((candidate) => candidate.operation === operation && candidate.path === path);
      if (!row) throw new Error(`no ${path} row for ${operation}`);
      const gas = row.gasUsed - baseline.gasUsed;
      overhead.push({ operation, path, gas, usdc: usdcAtObservedPrice(gas) });
    }
  }

  return {
    chainId: forkChain.id,
    forkBlock,
    entryPoint: ENTRY_POINT_V07,
    factory: SIMPLE_ACCOUNT_FACTORY_V07,
    gasPriceWei: ARC_OBSERVED_GAS_PRICE_WEI,
    rows,
    overhead,
    measuredAt: new Date().toISOString(),
  };
}

const pathLabel: Record<MeasurementPath, string> = {
  eoa: "EOA transaction",
  "userop-deployed": "UserOperation, account already deployed",
  "userop-deploying": "UserOperation, first op deploys the account",
};

function formatGas(value: bigint): string {
  return value.toLocaleString("en-US");
}

export function renderMarkdownTable(measurement: Measurement): string {
  const price = measurement.gasPriceWei;
  const gwei = formatUnits(price, 9);
  const lines = [
    `| Call | Path | Tx gas used | Cost at ${gwei} gwei (USDC) | Overhead vs EOA (gas) | Overhead (USDC) | Charged to account (gas) | Keeper net (USDC) |`,
    "|---|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const operation of ["setBudget", "submit"] as const) {
    for (const path of ["eoa", "userop-deployed", "userop-deploying"] as const) {
      const row = measurement.rows.find((candidate) => candidate.operation === operation && candidate.path === path);
      if (!row) continue;
      const over = measurement.overhead.find((candidate) => candidate.operation === operation && candidate.path === path);
      const keeperNet =
        row.keeperNetWei === null ? "n/a" : formatUnits(row.keeperNetWei, 18);
      lines.push(
        `| \`${operation}\` | ${pathLabel[path]} | ${formatGas(row.gasUsed)} | ${usdcAtObservedPrice(row.gasUsed, price)} | ${over ? formatGas(over.gas) : "0"} | ${over ? over.usdc : "0"} | ${row.actualGasUsed === null ? "n/a" : formatGas(row.actualGasUsed)} | ${keeperNet} |`,
      );
    }
  }
  return lines.join("\n");
}

export function serializeMeasurement(measurement: Measurement): string {
  return `${JSON.stringify(measurement, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value), 2)}\n`;
}

async function main(): Promise<void> {
  const fork = await startAnvilFork({ port: 8562 });
  try {
    const deployment = await deploySquareStack(fork.rpcUrl);
    const measurement = await runMeasurement({ rpcUrl: fork.rpcUrl, deployment });
    writeFileSync(measurementsPath, serializeMeasurement(measurement));
    process.stdout.write(`${renderMarkdownTable(measurement)}\n\nwritten ${measurementsPath}\n`);
  } finally {
    fork.stop();
  }
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
