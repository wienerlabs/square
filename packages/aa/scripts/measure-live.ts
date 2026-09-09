import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseEther, parseUnits, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSelfBundler } from "../src/selfBundler.js";
import { toSimpleSmartAccount } from "../src/simpleAccount.js";
import { ENTRY_POINT_V07, SIMPLE_ACCOUNT_FACTORY_V07 } from "../src/constants.js";
import { packageRoot, contractsDir, type SquareDeployment } from "./fork.js";
import { renderMarkdownTable, usdcAtObservedPrice, type Measurement, type MeasurementOverhead, type MeasurementRow } from "./measure.js";
import { createJob, encodeSetBudget, encodeSubmit, fundJob, readJob, setBudgetAsEoa, submitAsEoa, JobStatus, type FeeOptions, type SquareEnv } from "./square.js";

const rpcUrl = process.env["RPC_URL"] ?? "https://rpc.testnet.arc.io";
const chainId = Number(process.env["CHAIN_ID"] ?? 5042002);
const chain = defineChain({
  id: chainId,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});

function requiredKey(name: string): Hex {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value as Hex;
}

function row(operation: "setBudget" | "submit", path: MeasurementRow["path"], receipt: { transactionHash: Hex; gasUsed: bigint; effectiveGasPrice: bigint }, actual?: { actualGasUsed: bigint; actualGasCost: bigint }): MeasurementRow {
  return {
    operation,
    path,
    txHash: receipt.transactionHash,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    actualGasUsed: actual?.actualGasUsed ?? null,
    actualGasCost: actual?.actualGasCost ?? null,
    keeperNetWei: actual ? actual.actualGasCost - receipt.gasUsed * receipt.effectiveGasPrice : null,
  };
}

function highestEffectiveGasPrice(rows: readonly MeasurementRow[]): bigint {
  let highest = 0n;
  for (const entry of rows) if (entry.effectiveGasPrice > highest) highest = entry.effectiveGasPrice;
  if (highest === 0n) throw new Error("no receipt carried an effective gas price");
  return highest;
}

async function main(): Promise<void> {
  const deployment = JSON.parse(readFileSync(join(contractsDir, "deployments", `${chainId}.json`), "utf8")) as SquareDeployment;
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const wallet = (key: Hex) => createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(key) });
  const client = wallet(requiredKey("CLIENT_KEY"));
  const providerEoa = wallet(requiredKey("PROVIDER_KEY"));
  const keeper = wallet(requiredKey("KEEPER_KEY"));
  const owner = privateKeyToAccount(generatePrivateKey());
  const env: SquareEnv = { publicClient, deployment };
  const bundler = createSelfBundler({ walletClient: keeper, publicClient });
  const estimated = await publicClient.estimateFeesPerGas();
  const fees: FeeOptions = { maxFeePerGas: estimated.maxFeePerGas, maxPriorityFeePerGas: estimated.maxPriorityFeePerGas };
  const budget = parseUnits(process.env["BUDGET_USDC"] ?? "0.5", 6);
  const deposit = parseEther(process.env["DEPOSIT_USDC"] ?? "0.05");
  const deliverable = keccak256(toHex("deliverable:measurement:live"));
  const kernel = deployment.SquareJob;
  const startBlock = await publicClient.getBlockNumber();
  const rows: MeasurementRow[] = [];

  const jobA = await createJob(env, client, providerEoa.account.address, "spec:measure:eoa");
  rows.push(row("setBudget", "eoa", await setBudgetAsEoa(env, providerEoa, jobA, budget, fees)));
  await fundJob(env, client, jobA, budget);
  rows.push(row("submit", "eoa", await submitAsEoa(env, providerEoa, jobA, deliverable, fees)));
  console.log(`eoa path done on job ${jobA}`);

  const accountA = await toSimpleSmartAccount({ client: publicClient, owner, salt: 1n });
  await bundler.depositTo(accountA.address, deposit);
  const jobB = await createJob(env, client, accountA.address, "spec:measure:userop");
  const deployingSetBudget = await bundler.sendUserOperation(accountA, [{ to: kernel, data: encodeSetBudget(jobB, budget) }], fees);
  if (!deployingSetBudget.success) throw new Error(`setBudget user operation reverted: ${deployingSetBudget.revertReason ?? "no reason"}`);
  rows.push(row("setBudget", "userop-deploying", deployingSetBudget.receipt, deployingSetBudget));
  await fundJob(env, client, jobB, budget);
  const deployedSubmit = await bundler.sendUserOperation(accountA, [{ to: kernel, data: encodeSubmit(jobB, deliverable) }], fees);
  if (!deployedSubmit.success) throw new Error(`submit user operation reverted: ${deployedSubmit.revertReason ?? "no reason"}`);
  rows.push(row("submit", "userop-deployed", deployedSubmit.receipt, deployedSubmit));
  console.log(`smart account ${accountA.address} accepted and submitted job ${jobB}`);

  const jobC = await createJob(env, client, accountA.address, "spec:measure:userop");
  const deployedSetBudget = await bundler.sendUserOperation(accountA, [{ to: kernel, data: encodeSetBudget(jobC, budget) }], fees);
  if (!deployedSetBudget.success) throw new Error(`setBudget user operation reverted: ${deployedSetBudget.revertReason ?? "no reason"}`);
  rows.push(row("setBudget", "userop-deployed", deployedSetBudget.receipt, deployedSetBudget));

  const accountB = await toSimpleSmartAccount({ client: publicClient, owner, salt: 2n });
  await bundler.depositTo(accountB.address, deposit);
  const jobD = await createJob(env, client, accountB.address, "spec:measure:userop");
  await setBudgetAsEoa(env, client, jobD, budget);
  await fundJob(env, client, jobD, budget);
  const deployingSubmit = await bundler.sendUserOperation(accountB, [{ to: kernel, data: encodeSubmit(jobD, deliverable) }], fees);
  if (!deployingSubmit.success) throw new Error(`submit user operation reverted: ${deployingSubmit.revertReason ?? "no reason"}`);
  rows.push(row("submit", "userop-deploying", deployingSubmit.receipt, deployingSubmit));

  for (const jobId of [jobA, jobB, jobD]) {
    const record = await readJob(env, jobId);
    if (record.status !== JobStatus.Submitted) throw new Error(`job ${jobId} ended in status ${record.status}`);
  }

  const overhead: MeasurementOverhead[] = [];
  for (const operation of ["setBudget", "submit"] as const) {
    const baseline = rows.find((r) => r.operation === operation && r.path === "eoa");
    if (!baseline) throw new Error(`no EOA baseline for ${operation}`);
    for (const path of ["userop-deployed", "userop-deploying"] as const) {
      const found = rows.find((r) => r.operation === operation && r.path === path);
      if (!found) throw new Error(`no ${path} row for ${operation}`);
      const gas = found.gasUsed - baseline.gasUsed;
      overhead.push({ operation, path, gas, usdc: usdcAtObservedPrice(gas, found.effectiveGasPrice) });
    }
  }
  const measurement: Measurement = {
    chainId,
    forkBlock: startBlock,
    entryPoint: ENTRY_POINT_V07,
    factory: SIMPLE_ACCOUNT_FACTORY_V07,
    gasPriceWei: highestEffectiveGasPrice(rows),
    maxFeePerGasWei: fees.maxFeePerGas,
    rows,
    overhead,
    measuredAt: new Date().toISOString(),
  };
  const out = join(packageRoot, `measurements-${chainId}.json`);
  writeFileSync(out, JSON.stringify(measurement, (_, value) => (typeof value === "bigint" ? value.toString() : value), 2) + "\n");
  console.log(renderMarkdownTable(measurement));
  console.log(`written ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
