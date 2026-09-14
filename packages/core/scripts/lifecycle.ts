import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  formatUnits,
  http,
  parseEther,
  parseUnits,
  type Address,
  type Chain,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import {
  approveBuyers,
  createSquareClient,
  deploymentFromJson,
  eventsNamed,
  hashDeliverable,
  JobStatus,
  Outcome,
  squareJobAbi,
  type SquareClient,
  type SquareDeployment,
} from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const rpcUrl = process.env["RPC_URL"] ?? "http://127.0.0.1:8545";
const chainId = Number(process.env["CHAIN_ID"] ?? 31337);
const isAnvil = process.env["ANVIL"] === "1" || chainId === 31337;
const deploymentFile = process.env["SQUARE_DEPLOYMENT_FILE"] ?? join(here, "..", "..", "..", "contracts", "deployments", `${chainId}.json`);
const reportFile = process.env["LIFECYCLE_REPORT"] ?? join(here, "..", "..", "..", "docs", "deploy", `lifecycle-${chainId}.md`);
const actorsFile = process.env["LIFECYCLE_ACTORS_FILE"];
const funderKey = process.env["DEPLOYER_PRIVATE_KEY"] as Hex | undefined;
const fallbackGasPriceWei = BigInt(process.env["GAS_PRICE_WEI"] ?? "20000000000");
const explorer = process.env["EXPLORER_URL"] ?? (chainId === 5042002 ? "https://testnet.arcscan.app" : "");

const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const anvilKey = (index: number): Hex => `0x${Buffer.from(mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index }).getHdKey().privateKey ?? new Uint8Array()).toString("hex")}`;

interface Actors {
  client: Hex;
  provider: Hex;
  buyer: Hex;
  arbiterA: Hex;
  arbiterB: Hex;
  cranker: Hex;
}

interface Row {
  path: string;
  step: string;
  txHash: Hex;
  gasUsed: bigint;
  gasPriceWei: bigint;
  costWei: bigint;
}

const chain: Chain = defineChain({
  id: chainId,
  name: `chain-${chainId}`,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});

const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const testClient = createTestClient({ chain, mode: "anvil", transport: http(rpcUrl) });
const rows: Row[] = [];
let rowsPricedByFallback = 0;

function loadActors(): Actors {
  if (actorsFile && existsSync(actorsFile)) {
    const parsed = Object.fromEntries(
      readFileSync(actorsFile, "utf8")
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => line.split("=", 2) as [string, string]),
    );
    return {
      client: parsed["CLIENT_KEY"] as Hex,
      provider: parsed["PROVIDER_KEY"] as Hex,
      buyer: parsed["BUYER_KEY"] as Hex,
      arbiterA: parsed["ARBITER_A_KEY"] as Hex,
      arbiterB: parsed["ARBITER_B_KEY"] as Hex,
      cranker: parsed["CRANKER_KEY"] as Hex,
    };
  }
  if (isAnvil) {
    return { client: anvilKey(1), provider: anvilKey(2), buyer: anvilKey(3), arbiterA: anvilKey(4), arbiterB: anvilKey(5), cranker: anvilKey(7) };
  }
  const fresh: Actors = {
    client: generatePrivateKey(),
    provider: generatePrivateKey(),
    buyer: generatePrivateKey(),
    arbiterA: generatePrivateKey(),
    arbiterB: generatePrivateKey(),
    cranker: generatePrivateKey(),
  };
  if (actorsFile) {
    writeFileSync(
      actorsFile,
      Object.entries(fresh)
        .map(([name, key]) => `${name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}_KEY=${key}`)
        .join("\n") + "\n",
      { mode: 0o600 },
    );
  }
  return fresh;
}

function actor(deployment: SquareDeployment, key: Hex): SquareClient {
  return createSquareClient({
    publicClient,
    deployment,
    walletClient: createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(key) }),
  });
}

function record(path: string, step: string, receipt: TransactionReceipt): void {
  const carriesPrice = typeof receipt.effectiveGasPrice === "bigint" && receipt.effectiveGasPrice > 0n;
  if (!carriesPrice) rowsPricedByFallback += 1;
  const gasPriceWei = carriesPrice ? receipt.effectiveGasPrice : fallbackGasPriceWei;
  rows.push({
    path,
    step,
    txHash: receipt.transactionHash,
    gasUsed: receipt.gasUsed,
    gasPriceWei,
    costWei: receipt.gasUsed * gasPriceWei,
  });
  console.log(`${path} | ${step} | ${receipt.transactionHash} | ${receipt.gasUsed} gas at ${formatUnits(gasPriceWei, 9)} gwei`);
}

async function now(): Promise<bigint> {
  return (await publicClient.getBlock()).timestamp;
}

async function waitUntil(timestamp: bigint, label: string): Promise<void> {
  const current = await now();
  if (current >= timestamp) return;
  const gap = timestamp - current + 1n;
  if (isAnvil) {
    await testClient.increaseTime({ seconds: Number(gap) });
    await testClient.mine({ blocks: 1 });
    return;
  }
  console.log(`waiting ${gap}s for ${label}`);
  await new Promise((resolve) => setTimeout(resolve, Number(gap) * 1000 + 3000));
}

async function fundActors(deployment: SquareDeployment, actors: Actors): Promise<void> {
  const addresses = Object.values(actors).map((key) => privateKeyToAccount(key).address);
  if (isAnvil) {
    const funder = createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(anvilKey(0)) });
    const mintAbi = [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] }] as const;
    for (const address of addresses) {
      await testClient.setBalance({ address, value: parseEther("10") });
      const hash = await funder.writeContract({ abi: mintAbi, address: deployment.usdc, functionName: "mint", args: [address, parseUnits("500", 6)] });
      await publicClient.waitForTransactionReceipt({ hash });
    }
    return;
  }
  if (!funderKey) throw new Error("DEPLOYER_PRIVATE_KEY is required to fund the actors on a live chain");
  const funder = createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(funderKey) });
  const perActor = parseEther(process.env["FUND_PER_ACTOR"] ?? "1");
  const clientFund = parseEther(process.env["FUND_CLIENT"] ?? "7");
  const clientAddress = privateKeyToAccount(actors.client).address;
  for (const address of addresses) {
    const target = address === clientAddress ? clientFund : perActor;
    const balance = await publicClient.getBalance({ address });
    if (balance >= target) continue;
    const hash = await funder.sendTransaction({ to: address, value: target - balance });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`funded ${address} with ${formatUnits(target - balance, 18)} USDC`);
  }
}

const identityRegistryAbi = [
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "event", name: "Transfer", inputs: [{ name: "from", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "tokenId", type: "uint256", indexed: true }] },
] as const;

async function registerAgent(deployment: SquareDeployment, providerKey: Hex): Promise<bigint | undefined> {
  if (process.env["AGENT_ID"]) return BigInt(process.env["AGENT_ID"]);
  if (process.env["REGISTER_AGENT"] !== "1") return isAnvil ? 1n : undefined;
  const wallet = createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(providerKey) });
  const hash = await wallet.writeContract({ abi: identityRegistryAbi, address: deployment.identityRegistry, functionName: "register" });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  record("0-identity", "IdentityRegistry.register (provider agent)", receipt);
  const minted = receipt.logs.find((log) => log.address.toLowerCase() === deployment.identityRegistry.toLowerCase() && log.topics.length === 4);
  if (!minted || !minted.topics[3]) throw new Error("registration minted no agent");
  const agentId = BigInt(minted.topics[3]);
  console.log(`provider registered as ERC-8004 agent ${agentId}`);
  return agentId;
}

let agentId: bigint | undefined;

async function submittedJob(client: SquareClient, provider: SquareClient, budget: bigint, path: string, expiryOffset = 30n * 24n * 3600n): Promise<bigint> {
  const created = await client.createJob({ provider: provider.account, expiredAt: (await now()) + expiryOffset, spec: { path, at: Date.now() } });
  record(path, "createJob", created.receipt);
  record(path, "setBudget", (await provider.setBudget(created.jobId, budget)).receipt);
  record(path, "fund", (await client.fund(created.jobId, budget)).receipt);
  const submitArgs = agentId === undefined ? { jobId: created.jobId, deliverable: hashDeliverable(`${path} ${created.jobId}`) } : { jobId: created.jobId, deliverable: hashDeliverable(`${path} ${created.jobId}`), agentId };
  record(path, "submit", (await provider.submit(submitArgs)).receipt);
  return created.jobId;
}

async function expectRevert(label: string, fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (pattern.test(message)) {
      console.log(`adversarial | ${label} | reverted as expected (${pattern.source})`);
      rows.push({ path: "adversarial", step: `${label}: reverted with ${pattern.source}`, txHash: "0x", gasUsed: 0n, gasPriceWei: 0n, costWei: 0n });
      return;
    }
    throw new Error(`${label} reverted with an unexpected error: ${message}`);
  }
  throw new Error(`${label} did not revert`);
}

async function main(): Promise<void> {
  const deployment = deploymentFromJson(JSON.parse(readFileSync(deploymentFile, "utf8")));
  const actors = loadActors();
  await fundActors(deployment, actors);
  const client = actor(deployment, actors.client);
  const provider = actor(deployment, actors.provider);
  const buyer = actor(deployment, actors.buyer);
  const arbiterA = actor(deployment, actors.arbiterA);
  const arbiterB = actor(deployment, actors.arbiterB);
  const cranker = actor(deployment, actors.cranker);
  const budget = parseUnits(process.env["BUDGET_USDC"] ?? "5", 6);
  const horizon = BigInt(await client.settlementHorizon());
  agentId = await registerAgent(deployment, actors.provider);

  const optimistic = await submittedJob(client, provider, budget, "1-optimistic");
  await expectRevert("finalize before the window closes", () => cranker.finalize(optimistic), /WindowOpen/);
  await waitUntil(BigInt(await client.challengeEndsAt(optimistic)), "the challenge window");
  const finalized = await cranker.finalize(optimistic);
  record("1-optimistic", "finalize (permissionless)", finalized.receipt);
  const reputation = finalized.events.find((e) => e.contract === "SquareHook" && (e.eventName === "ReputationRecorded" || e.eventName === "ReputationWriteFailed"));
  if (reputation) console.log(`1-optimistic | ${reputation.eventName} | agent ${agentId ?? "none"}`);
  if (agentId !== undefined && reputation?.eventName !== "ReputationRecorded") throw new Error("reputation was not written for the registered agent");
  record("1-optimistic", "withdraw", (await provider.withdraw()).receipt);
  if ((await client.getJobRecord(optimistic)).status !== JobStatus.Completed) throw new Error("optimistic job did not complete");

  const rejectPath = await submittedJob(client, provider, budget, "2a-dispute-client-wins");
  record("2a-dispute-client-wins", "dispute (bonded)", (await client.dispute(rejectPath, hashDeliverable("evidence"))).receipt);
  record("2a-dispute-client-wins", "vote 1/2", (await arbiterA.vote(rejectPath, Outcome.Reject, 0)).receipt);
  await expectRevert("finalizeDecided below the threshold", () => cranker.finalizeDecided(rejectPath), /NotDecided/);
  record("2a-dispute-client-wins", "vote 2/2 (applies the rejection)", (await arbiterB.vote(rejectPath, Outcome.Reject, 0)).receipt);
  record("2a-dispute-client-wins", "withdrawBond", (await client.withdrawBond()).receipt);
  if ((await client.getJobRecord(rejectPath)).status !== JobStatus.Rejected) throw new Error("rejection did not apply");

  const completePath = await submittedJob(client, provider, budget, "2b-dispute-provider-wins");
  record("2b-dispute-provider-wins", "dispute (bonded)", (await client.dispute(completePath, hashDeliverable("evidence"))).receipt);
  record("2b-dispute-provider-wins", "vote 1/2", (await arbiterA.vote(completePath, Outcome.Complete, 10_000)).receipt);
  record("2b-dispute-provider-wins", "vote 2/2", (await arbiterB.vote(completePath, Outcome.Complete, 10_000)).receipt);
  record("2b-dispute-provider-wins", "finalizeDecided (permissionless)", (await cranker.finalizeDecided(completePath)).receipt);
  record("2b-dispute-provider-wins", "withdrawBond (provider takes the bond)", (await provider.withdrawBond()).receipt);

  const splitPath = await submittedJob(client, provider, budget, "2c-dispute-split");
  record("2c-dispute-split", "dispute (bonded)", (await client.dispute(splitPath, hashDeliverable("evidence"))).receipt);
  record("2c-dispute-split", "vote 1/2 (4000 bps)", (await arbiterA.vote(splitPath, Outcome.Complete, 4_000)).receipt);
  record("2c-dispute-split", "vote 2/2 (4000 bps)", (await arbiterB.vote(splitPath, Outcome.Complete, 4_000)).receipt);
  const split = await cranker.finalizeDecided(splitPath);
  record("2c-dispute-split", "finalizeDecided (split through the hook)", split.receipt);
  const routed = eventsNamed(split.events, "PayoutRouted")[0];
  if (!routed || routed.args.providerBps !== 4_000) throw new Error("split was not routed through the hook");
  record("2c-dispute-split", "withdrawBond (returned to the client)", (await client.withdrawBond()).receipt);
  record("2c-dispute-split", "withdraw (client share)", (await client.withdraw()).receipt);

  const expiryPath = "3-expiry";
  const expiring = await client.createJob({ provider: provider.account, expiredAt: (await now()) + horizon + 30n, spec: { path: expiryPath } });
  record(expiryPath, "createJob (short expiry)", expiring.receipt);
  record(expiryPath, "setBudget", (await provider.setBudget(expiring.jobId, budget)).receipt);
  record(expiryPath, "fund", (await client.fund(expiring.jobId, budget)).receipt);
  await expectRevert("claimRefund before expiry", () => cranker.claimRefund(expiring.jobId), /NotExpired/);

  const cancelPath = "4-cancel-before-funding";
  const cancelled = await client.createJob({ provider: provider.account, expiredAt: (await now()) + 30n * 24n * 3600n, spec: { path: cancelPath } });
  record(cancelPath, "createJob", cancelled.receipt);
  record(cancelPath, "setBudget", (await provider.setBudget(cancelled.jobId, budget)).receipt);
  record(cancelPath, "reject (client, Open)", (await client.reject(cancelled.jobId)).receipt);

  const receivablePath = "6-receivable";
  const sold = await submittedJob(client, provider, budget, receivablePath);
  record(receivablePath, "list", (await provider.listClaim(sold, (budget * 9n) / 10n)).receipt);
  // square#30: the receivable sells only to a buyer the client's policy approved.
  const approved = approveBuyers([buyer.account]);
  record(receivablePath, "setBuyerRoot (the client approves the buyer)", (await client.setBuyerRoot(approved.root)).receipt);
  await expectRevert(
    "buy by an address the client did not approve",
    () => cranker.buyClaim(sold, approved.eligibilityOf(buyer.account), { autoApprove: false }),
    /BuyerNotEligible/,
  );
  record(receivablePath, "buy", (await buyer.buyClaim(sold, approved.eligibilityOf(buyer.account))).receipt);
  await waitUntil(BigInt(await client.challengeEndsAt(sold)), "the challenge window of the sold receivable");
  const paidToBuyer = await cranker.finalize(sold);
  record(receivablePath, "finalize (pays the buyer)", paidToBuyer.receipt);
  const released = eventsNamed(paidToBuyer.events, "PaymentReleased")[0];
  if (released?.args.provider.toLowerCase() !== buyer.account.toLowerCase()) throw new Error("the buyer was not paid");

  await expectRevert(
    "createJob with a non-whitelisted hook",
    () => client.createJob({ provider: provider.account, expiredAt: 0n, description: "x", hook: deployment.usdc }),
    /ExpiryInPast|HookNotWhitelisted/,
  );
  await expectRevert(
    "createJob with a non-whitelisted hook and a valid expiry",
    async () => {
      const expiredAt = (await now()) + 30n * 24n * 3600n;
      return client.createJob({ provider: provider.account, expiredAt, description: "x", hook: deployment.usdc });
    },
    /HookNotWhitelisted/,
  );
  await expectRevert("dispute by a stranger", () => buyer.dispute(optimistic), /NotSubmitted|OnlyClient/);
  await expectRevert("vote by a non-arbiter", () => buyer.vote(rejectPath, Outcome.Reject, 0), /AlreadyDecided|NotAnArbiter/);
  await expectRevert("double finalize", () => cranker.finalize(optimistic), /NotSubmitted/);

  await waitUntil(BigInt((await client.getJobRecord(expiring.jobId)).expiredAt), "the short expiry");
  record(expiryPath, "claimRefund (anyone)", (await cranker.claimRefund(expiring.jobId)).receipt);
  record(expiryPath, "withdraw (client)", (await client.withdraw()).receipt);
  if ((await client.getJobRecord(expiring.jobId)).status !== JobStatus.Expired) throw new Error("expiry did not apply");

  const totalGas = rows.reduce((sum, row) => sum + row.gasUsed, 0n);
  const totalCostWei = rows.reduce((sum, row) => sum + row.costWei, 0n);
  const perPathGas = new Map<string, bigint>();
  const perPathCostWei = new Map<string, bigint>();
  for (const row of rows) {
    perPathGas.set(row.path, (perPathGas.get(row.path) ?? 0n) + row.gasUsed);
    perPathCostWei.set(row.path, (perPathCostWei.get(row.path) ?? 0n) + row.costWei);
  }
  const usdcOf = (costWei: bigint): string => formatUnits(costWei / 1_000_000_000_000n, 6);
  const link = (hash: Hex): string => (hash === "0x" ? "" : explorer ? `[${hash.slice(0, 10)}...](${explorer}/tx/${hash})` : hash);
  const pricedRows = rows.filter((row) => row.gasUsed > 0n);
  const prices = pricedRows.map((row) => row.gasPriceWei);
  const lowestPrice = prices.reduce((low, price) => (price < low ? price : low), prices[0] ?? fallbackGasPriceWei);
  const highestPrice = prices.reduce((high, price) => (price > high ? price : high), prices[0] ?? fallbackGasPriceWei);
  const priceRange =
    lowestPrice === highestPrice
      ? `${formatUnits(lowestPrice, 9)} gwei on every row`
      : `${formatUnits(lowestPrice, 9)} to ${formatUnits(highestPrice, 9)} gwei`;
  const runAt = new Date();
  const reportExtension = extname(reportFile);
  const datedReportFile = join(
    dirname(reportFile),
    `${basename(reportFile, reportExtension)}-${runAt.toISOString().slice(0, 10)}${reportExtension}`,
  );
  const lines = [
    `# Lifecycle run on chain ${chainId}`,
    "",
    `Run at ${runAt.toISOString()} against ${rpcUrl}.`,
    "",
    `The USDC column prices every row at its own receipt's \`effectiveGasPrice\`, ${priceRange} on this run. \`GAS_PRICE_WEI\` (${formatUnits(fallbackGasPriceWei, 9)} gwei) is a fallback for a receipt that carries no effective price and nothing else; it priced ${rowsPricedByFallback} of the ${pricedRows.length} rows below.`,
    "",
    `This run is also kept as [${basename(datedReportFile)}](./${basename(datedReportFile)}), which nothing overwrites. \`${basename(reportFile)}\` is rewritten on every run, so a document that quotes a figure by number should link the dated file instead.`,
    "",
    "| Path | Step | Transaction | Gas |",
    "|---|---|---|---|",
    ...rows.map((row) => `| ${row.path} | ${row.step} | ${link(row.txHash)} | ${row.gasUsed === 0n ? "" : row.gasUsed.toString()} |`),
    "",
    "## Per path",
    "",
    "| Path | Gas | USDC |",
    "|---|---|---|",
    ...[...perPathGas.entries()]
      .filter(([, gas]) => gas > 0n)
      .map(([path, gas]) => `| ${path} | ${gas} | ${usdcOf(perPathCostWei.get(path) ?? 0n)} |`),
    `| all | ${totalGas} | ${usdcOf(totalCostWei)} |`,
    "",
    "## Deployment",
    "",
    "| Contract | Address |",
    "|---|---|",
    ...Object.entries(deployment)
      .filter(([key]) => key !== "chainId")
      .map(([key, value]) => `| ${key} | ${explorer ? `[${value}](${explorer}/address/${value})` : value} |`),
    "",
  ];
  mkdirSync(dirname(reportFile), { recursive: true });
  const report = lines.join("\n");
  writeFileSync(datedReportFile, report);
  writeFileSync(reportFile, report);
  console.log(`report written to ${datedReportFile} and refreshed at ${reportFile}`);
  const counter = await publicClient.readContract({ abi: squareJobAbi, address: deployment.squareJob, functionName: "jobCounter" });
  console.log(`jobs on chain: ${counter}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

export type { Address };
