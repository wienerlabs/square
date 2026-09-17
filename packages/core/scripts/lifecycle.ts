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
import { AipDidResolver, formatDid } from "@squaresdk/did-resolver";
import {
  approveBuyers,
  createScreenerClient,
  createSquareClient,
  decodeSquareLogs,
  deploymentFromJson,
  eventsNamed,
  hashDeliverable,
  JobStatus,
  Outcome,
  squareJobAbi,
  type SquareClient,
  type SquareDeployment,
  type SquareEvent,
  type TransactionResult,
} from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
// A stack whose hook holds a compliance module gates every release on a
// proof the client binds (square#335). The runner then needs the client's
// policy and a prover, and binds a proof before each release it cranks;
// without them it stops here rather than run a lifecycle whose every
// release would pay the client back. @squaresdk/policy is loaded from its
// build beside this package, not declared, so core carries no dependency on
// a package that depends on it. The prover is either the circuit's files,
// proved with in this process the way the institutions' tools do (square#347,
// LIFECYCLE_PROVER_ARTIFACTS), or a prover service (LIFECYCLE_PROVER_URL).
const policyFile = process.env["LIFECYCLE_POLICY_FILE"];
const proverUrl = process.env["LIFECYCLE_PROVER_URL"];
const proverArtifacts = process.env["LIFECYCLE_PROVER_ARTIFACTS"];
// square#368: on a hook that screens, the parties of every job are screened
// before it is funded; this is the screener asked for whoever lacks a record.
const screenerUrl = process.env["LIFECYCLE_SCREENER_URL"];
const rpcUrl = process.env["RPC_URL"] ?? "http://127.0.0.1:8545";
const chainId = Number(process.env["CHAIN_ID"] ?? 31337);
const isAnvil = process.env["ANVIL"] === "1" || chainId === 31337;
// square#31, square#336: who closes a window. "self", the default, is the
// runner as it was: the cranker calls finalize / finalizeDecided and the row
// is its receipt. "keeper" is for a chain a keeper watches: the runner leaves
// every settlement to it, waits for the job to leave Submitted, and records
// the transaction that settled it and who sent it. A crank of the runner's
// own would only race the keeper's and lose with NotSubmitted. On a gated
// stack the proof is then bound before the window closes rather than after,
// because the keeper releases with whatever is bound at that instant
// (docs/decisions/proof-freshness.md), and time is waited out for real,
// since a keeper reads the clock and not anvil's.
const finalizer = process.env["LIFECYCLE_FINALIZER"] ?? "self";
if (finalizer !== "self" && finalizer !== "keeper") throw new Error(`LIFECYCLE_FINALIZER is "${finalizer}"; it is "self" or "keeper"`);
const keeperSettles = finalizer === "keeper";
const settlementTimeoutMs = Number(process.env["LIFECYCLE_SETTLEMENT_TIMEOUT_MS"] ?? 600_000);
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

/**
 * square#31's eight steps, from the mandate to the payment, with the
 * receivable sold in between (docs/design/mandate-to-payment.md). The rows
 * of the run that are each step's evidence are collected under its number
 * as they are recorded, and the report writes them out as a second table.
 */
const EIGHT_STEPS: ReadonlyArray<readonly [number, string]> = [
  [1, "The institution commits a spending policy: its commitment is on the chain"],
  [2, "An agent is registered in ERC-8004 and resolves as did:aip"],
  [3, "The institution opens a job for the agent; the USDC is locked in escrow"],
  [4, "The agent delivers; the challenge window opens"],
  [5, "The agent lists its receivable at a discount; an approved buyer takes it, and the agent is paid now"],
  [6, "The window closes without a dispute; the keeper finalizes"],
  [7, "The release asks for the zero-knowledge proof: this payment fits the mandate"],
  [8, "The payment goes to the buyer; the reputation stays with the agent, in ERC-8004"],
];
const eight = new Map<number, Row[]>();
function stepped(step: number, row: Row): Row {
  eight.set(step, [...(eight.get(step) ?? []), row]);
  return row;
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
    ...(screenerUrl ? { screener: createScreenerClient({ url: screenerUrl }) } : {}),
  });
}

function record(path: string, step: string, receipt: TransactionReceipt): Row {
  const carriesPrice = typeof receipt.effectiveGasPrice === "bigint" && receipt.effectiveGasPrice > 0n;
  if (!carriesPrice) rowsPricedByFallback += 1;
  const gasPriceWei = carriesPrice ? receipt.effectiveGasPrice : fallbackGasPriceWei;
  const row: Row = {
    path,
    step,
    txHash: receipt.transactionHash,
    gasUsed: receipt.gasUsed,
    gasPriceWei,
    costWei: receipt.gasUsed * gasPriceWei,
  };
  rows.push(row);
  console.log(`${path} | ${step} | ${receipt.transactionHash} | ${receipt.gasUsed} gas at ${formatUnits(gasPriceWei, 9)} gwei`);
  return row;
}

/** A row with no transaction: something the run read or established rather than sent. */
function note(path: string, step: string): Row {
  const row: Row = { path, step, txHash: "0x", gasUsed: 0n, gasPriceWei: 0n, costWei: 0n };
  rows.push(row);
  console.log(`${path} | ${step}`);
  return row;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function now(): Promise<bigint> {
  return (await publicClient.getBlock()).timestamp;
}

async function waitUntil(timestamp: bigint, label: string): Promise<void> {
  const current = await now();
  if (current >= timestamp) return;
  const gap = timestamp - current + 1n;
  if (isAnvil && !keeperSettles) {
    await testClient.increaseTime({ seconds: Number(gap) });
    await testClient.mine({ blocks: 1 });
    return;
  }
  if (keeperSettles && gap > 3600n) {
    throw new Error(`${label} is ${gap}s away and a keeper reads the clock, so the wait is real; run keeper mode against a stack whose windows are minutes (CHALLENGE_WINDOW on DeploySettlement), not this one`);
  }
  console.log(`waiting ${gap}s for ${label}`);
  await sleep(Number(gap) * 1000 + 3000);
}

/** The block each job was created in, where the search for its settlement starts. */
const bornAt = new Map<bigint, bigint>();

interface Settlement {
  row: Row;
  receipt: TransactionReceipt;
  events: SquareEvent[];
}

/**
 * The transaction that settles a Submitted job: the runner's own crank in
 * "self" mode, or, in "keeper" mode, whoever's landed, read back from the
 * kernel's JobCompleted / JobRejected / JobExpired once the job has left
 * Submitted, with the sender named in the row.
 */
async function settle(path: string, label: string, jobId: bigint, own: () => Promise<TransactionResult>, deployment: SquareDeployment, client: SquareClient): Promise<Settlement> {
  if (!keeperSettles) {
    const result = await own();
    return { row: record(path, label, result.receipt), receipt: result.receipt, events: result.events };
  }
  const deadline = Date.now() + settlementTimeoutMs;
  console.log(`${path} | waiting for the keeper to settle job ${jobId}`);
  while ((await client.getJobRecord(jobId)).status === JobStatus.Submitted) {
    if (Date.now() > deadline) {
      throw new Error(`${path}: job ${jobId} was still Submitted ${Math.round(settlementTimeoutMs / 1000)}s after it became settleable; is a keeper running against ${rpcUrl}, and is the job's budget above its profitability bar?`);
    }
    await sleep(isAnvil ? 1000 : 3000);
  }
  const logs = await publicClient.getLogs({ address: deployment.squareJob, fromBlock: bornAt.get(jobId) ?? 0n, toBlock: "latest" });
  const settled = decodeSquareLogs(logs, deployment).find(
    (event) => (event.eventName === "JobCompleted" || event.eventName === "JobRejected" || event.eventName === "JobExpired") && event.args.jobId === jobId,
  );
  if (!settled || !settled.transactionHash) throw new Error(`${path}: job ${jobId} left Submitted but no JobCompleted, JobRejected or JobExpired names it`);
  const receipt = await publicClient.getTransactionReceipt({ hash: settled.transactionHash });
  const row = record(path, `${label} (sent by the keeper ${receipt.from})`, receipt);
  return { row, receipt, events: decodeSquareLogs(receipt.logs, deployment) };
}

async function fundActors(deployment: SquareDeployment, actors: Actors, budget: bigint): Promise<void> {
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
  // The buyer pays the receivable's asking price, nine tenths of the budget, and
  // on a live chain that is the native USDC the funder sends here: the kernel
  // counts it through the ERC-20 mirror in 6 decimals, the balance holds it in
  // 18. Anvil above mints 500 to everyone, which hid this from the fork run.
  const buyerFund = ((budget * 9n) / 10n) * 10n ** 12n + perActor;
  const clientAddress = privateKeyToAccount(actors.client).address;
  const buyerAddress = privateKeyToAccount(actors.buyer).address;
  for (const address of addresses) {
    const target = address === clientAddress ? clientFund : address === buyerAddress ? buyerFund : perActor;
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
  stepped(2, record("0-identity", "IdentityRegistry.register (provider agent)", receipt));
  const minted = receipt.logs.find((log) => log.address.toLowerCase() === deployment.identityRegistry.toLowerCase() && log.topics.length === 4);
  if (!minted || !minted.topics[3]) throw new Error("registration minted no agent");
  const agentId = BigInt(minted.topics[3]);
  console.log(`provider registered as ERC-8004 agent ${agentId}`);
  return agentId;
}

let agentId: bigint | undefined;

async function submittedJob(client: SquareClient, provider: SquareClient, budget: bigint, path: string, expiryOffset = 30n * 24n * 3600n): Promise<bigint> {
  // The receivable path is square#31's flow, so its rows are the steps' evidence.
  const step = (n: number, row: Row): Row => (path === RECEIVABLE_PATH ? stepped(n, row) : row);
  const created = await client.createJob({ provider: provider.account, expiredAt: (await now()) + expiryOffset, spec: { path, at: Date.now() } });
  bornAt.set(created.jobId, created.receipt.blockNumber);
  step(3, record(path, "createJob", created.receipt));
  step(3, record(path, "setBudget", (await provider.setBudget(created.jobId, budget)).receipt));
  step(3, record(path, "fund", (await client.fund(created.jobId, budget)).receipt));
  const submitArgs = agentId === undefined ? { jobId: created.jobId, deliverable: hashDeliverable(`${path} ${created.jobId}`) } : { jobId: created.jobId, deliverable: hashDeliverable(`${path} ${created.jobId}`), agentId };
  step(4, record(path, "submit", (await provider.submit(submitArgs)).receipt));
  return created.jobId;
}
const RECEIVABLE_PATH = "6-receivable";

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

type PolicyModule = typeof import("../../policy/dist/index.js");
type PolicyNodeModule = typeof import("../../policy/dist/node.js");
interface Gate {
  module: Address;
  policy: import("../../policy/dist/index.js").Policy;
  prover: import("../../policy/dist/index.js").Prover & { close?: () => Promise<void> };
  bind: PolicyModule["bindComplianceProof"];
  facts: PolicyModule["releaseFacts"];
  verdict: PolicyModule["moduleVerdict"];
}

/** The module, the policy and the prover, when the stack gates releases; null when it does not. */
async function gateFor(client: SquareClient): Promise<Gate | null> {
  const module = await client.complianceModule();
  if (module === null) {
    if (policyFile || proverUrl || proverArtifacts) console.log("the hook holds no compliance module; LIFECYCLE_POLICY_FILE, LIFECYCLE_PROVER_ARTIFACTS and LIFECYCLE_PROVER_URL are not used");
    stepped(1, note("0-policy", "not on this stack: the hook holds no compliance module, so no release asks for a proof and no policy is committed"));
    return null;
  }
  if (!policyFile || (!proverUrl && !proverArtifacts)) {
    throw new Error(`the hook holds a compliance module (${module}); set LIFECYCLE_POLICY_FILE and either LIFECYCLE_PROVER_ARTIFACTS (the directory holding payment.wasm, payment.zkey and payment_vk.json) or LIFECYCLE_PROVER_URL so the client can prove its releases`);
  }
  const policyPkg = (await import(join(here, "..", "..", "policy", "dist", "index.js"))) as PolicyModule;
  const prover = proverArtifacts
    ? ((await import(join(here, "..", "..", "policy", "dist", "node.js"))) as PolicyNodeModule).createLocalProver({ artifacts: proverArtifacts })
    : policyPkg.createProverClient({ url: proverUrl as string });
  const policy = policyPkg.parsePolicy(JSON.parse(readFileSync(policyFile, "utf8")));
  if (policy.operator_id.toLowerCase() !== client.account.toLowerCase()) {
    throw new Error(`${policyFile} is ${policy.operator_id}'s policy; the lifecycle's client is ${client.account}`);
  }
  const commitment = await policyPkg.policyCommitment(policy);
  const onChain = await client.policyOf(client.account);
  if (onChain.commitment.toLowerCase() !== commitment.hex.toLowerCase()) {
    const committed = await client.setPolicy(commitment.hex, BigInt(policy.max_daily_spend));
    stepped(1, record("0-policy", `setPolicy (the client commits its policy, commitment ${commitment.hex})`, committed.receipt));
  } else {
    stepped(1, note("0-policy", `the client's commitment ${commitment.hex} was already on the chain, from an earlier run`));
  }
  console.log(`0-policy | module ${module} | commitment ${commitment.hex} | proving ${proverArtifacts ? `in this process from ${proverArtifacts}` : `at ${proverUrl}`}`);
  return { module, policy, prover, bind: policyPkg.bindComplianceProof, facts: policyPkg.releaseFacts, verdict: policyPkg.moduleVerdict };
}

/** With a module installed, the release the receipt carries was verified by it; anything else fails the run. */
function verified(gate: Gate | null, settlement: Settlement, path: string): void {
  if (gate === null) return;
  const verdict = gate.verdict(settlement.receipt, gate.module);
  if (verdict?.verified !== true) throw new Error(`${path}: the module did not verify the release (${verdict === null ? "no verdict in the receipt" : `refused, reason ${verdict.reason ?? "unknown"}`})`);
}

/**
 * Bind a proof for the release as it stands now, and record it; a refusal is
 * a failure of the run. `split` is for keeper mode's decided disputes, where
 * the proof has to be on the job before the deciding vote lands (the keeper
 * cranks on its next tick after it) and so names the split that vote is
 * about to set: the release will pay `net * split / 10 000`. A real client
 * cannot know the decision before it lands, which is the race square#345
 * closes on the keeper's side; the runner is also the arbiters here.
 */
async function prove(gate: Gate | null, client: SquareClient, jobId: bigint, path: string, split?: number): Promise<Row | null> {
  if (gate === null) return null;
  const facts = split === undefined ? undefined : await gate.facts(client, jobId).then((f) => ({ ...f, amount: (f.net * BigInt(split)) / 10_000n, providerBps: split }));
  const outcome = await gate.bind({ client, policy: gate.policy, prover: gate.prover, jobId, category: LIFECYCLE_CATEGORY, facts });
  if (!outcome.bound) {
    const why = outcome.reason === "not-compliant" ? `not compliant: ${(outcome.violated ?? ["rules unknown"]).join(", ")}` : `${outcome.reason}: ${outcome.detail}`;
    throw new Error(`${path}: no proof could be bound to job ${jobId} (${why})`);
  }
  const receipt = await client.publicClient.waitForTransactionReceipt({ hash: outcome.transaction });
  return record(path, `setComplianceProof (payee ${outcome.facts.payee}, ${formatUnits(outcome.facts.amount, 6)} USDC)`, receipt);
}
const LIFECYCLE_CATEGORY = "lifecycle";

/**
 * The window closes with the proof on the job. In "self" mode the runner
 * cranks next, so the proof is bound after the close, to the release as it
 * stands then. In "keeper" mode whoever watches the chain cranks at the
 * close, so the proof is bound before it, and only when the close is within
 * half the module's tolerance: further out, the proof would be stale by the
 * time it is read, and keeping it current is the duty's job, not this
 * runner's (square policy watch).
 */
async function closeWindow(gate: Gate | null, client: SquareClient, jobId: bigint, path: string, label: string): Promise<Row | null> {
  const end = BigInt(await client.challengeEndsAt(jobId));
  if (!keeperSettles) {
    await waitUntil(end, label);
    return prove(gate, client, jobId, path);
  }
  if (gate !== null) {
    const tolerance = (await client.complianceTolerance()) ?? 0n;
    const remaining = end - (await now());
    if (remaining > tolerance / 2n) {
      throw new Error(`${path}: ${label} closes in ${remaining}s and the module's tolerance is ${tolerance}s; a proof bound now would be stale by then, and keeping it current is the client's duty, which this runner does not carry`);
    }
  }
  const bound = await prove(gate, client, jobId, path);
  await waitUntil(end, label);
  return bound;
}

/**
 * square#31's second step, read back: the agent resolves as a did:aip whose
 * controller is its ERC-8004 owner, which on this run is the provider.
 */
async function resolveAgent(deployment: SquareDeployment, providerKey: Hex): Promise<void> {
  if (agentId === undefined) {
    stepped(2, note("0-identity", "no agent: submit carries no ERC-8004 id on this run (REGISTER_AGENT=1 or AGENT_ID binds one)"));
    return;
  }
  const did = formatDid(chainId, deployment.identityRegistry, agentId);
  const resolver = new AipDidResolver({ rpc: { [chainId]: rpcUrl }, timeoutMs: 15_000 });
  const { didDocument, didResolutionMetadata, didDocumentMetadata } = await resolver.resolve(did);
  if (didDocument === null) throw new Error(`${did} does not resolve: ${didResolutionMetadata.error ?? "no document"}`);
  const controller = Array.isArray(didDocument.controller) ? didDocument.controller.join(", ") : didDocument.controller;
  const owner = privateKeyToAccount(providerKey).address;
  const ownedByProvider = typeof controller === "string" && controller.toLowerCase().endsWith(owner.toLowerCase());
  const file = didDocumentMetadata.registrationFile ?? "none";
  stepped(2, note("0-identity", `${did} resolves; controller ${controller ?? "none"}${ownedByProvider ? " (the provider)" : ""}; registration file ${file}`));
  if (!ownedByProvider && process.env["AGENT_ID"] === undefined) throw new Error(`agent ${agentId} resolves to ${controller}, not to the provider ${owner}`);
}

async function main(): Promise<void> {
  const deployment = deploymentFromJson(JSON.parse(readFileSync(deploymentFile, "utf8")));
  const actors = loadActors();
  const budget = parseUnits(process.env["BUDGET_USDC"] ?? "5", 6);
  await fundActors(deployment, actors, budget);
  const client = actor(deployment, actors.client);
  const gate = await gateFor(client);
  const provider = actor(deployment, actors.provider);
  const buyer = actor(deployment, actors.buyer);
  const arbiterA = actor(deployment, actors.arbiterA);
  const arbiterB = actor(deployment, actors.arbiterB);
  const cranker = actor(deployment, actors.cranker);
  const horizon = BigInt(await client.settlementHorizon());
  agentId = await registerAgent(deployment, actors.provider);
  await resolveAgent(deployment, actors.provider);

  const optimistic = await submittedJob(client, provider, budget, "1-optimistic");
  await expectRevert("finalize before the window closes", () => cranker.finalize(optimistic), /WindowOpen/);
  await closeWindow(gate, client, optimistic, "1-optimistic", "the challenge window");
  const finalized = await settle("1-optimistic", "finalize (permissionless)", optimistic, () => cranker.finalize(optimistic), deployment, client);
  verified(gate, finalized, "1-optimistic");
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
  if (keeperSettles) await prove(gate, client, completePath, "2b-dispute-provider-wins", 10_000);
  record("2b-dispute-provider-wins", "vote 2/2", (await arbiterB.vote(completePath, Outcome.Complete, 10_000)).receipt);
  if (!keeperSettles) await prove(gate, client, completePath, "2b-dispute-provider-wins");
  const decided = await settle("2b-dispute-provider-wins", "finalizeDecided (permissionless)", completePath, () => cranker.finalizeDecided(completePath), deployment, client);
  verified(gate, decided, "2b-dispute-provider-wins");
  record("2b-dispute-provider-wins", "withdrawBond (provider takes the bond)", (await provider.withdrawBond()).receipt);

  const splitPath = await submittedJob(client, provider, budget, "2c-dispute-split");
  record("2c-dispute-split", "dispute (bonded)", (await client.dispute(splitPath, hashDeliverable("evidence"))).receipt);
  record("2c-dispute-split", "vote 1/2 (4000 bps)", (await arbiterA.vote(splitPath, Outcome.Complete, 4_000)).receipt);
  if (keeperSettles) await prove(gate, client, splitPath, "2c-dispute-split", 4_000);
  record("2c-dispute-split", "vote 2/2 (4000 bps)", (await arbiterB.vote(splitPath, Outcome.Complete, 4_000)).receipt);
  if (!keeperSettles) await prove(gate, client, splitPath, "2c-dispute-split");
  const split = await settle("2c-dispute-split", "finalizeDecided (split through the hook)", splitPath, () => cranker.finalizeDecided(splitPath), deployment, client);
  verified(gate, split, "2c-dispute-split");
  const routed = eventsNamed(split.events, "PayoutRouted")[0];
  if (!routed || routed.args.providerBps !== 4_000) throw new Error("split was not routed through the hook");
  record("2c-dispute-split", "withdrawBond (returned to the client)", (await client.withdrawBond()).receipt);
  record("2c-dispute-split", "withdraw (client share)", (await client.withdraw()).receipt);

  const expiryPath = "3-expiry";
  // Two minutes past the window: since square#326 `fund` refuses a job whose
  // window no longer fits before its expiry, and createJob, setBudget and fund
  // are three transactions apart on a live chain.
  const expiring = await client.createJob({ provider: provider.account, expiredAt: (await now()) + horizon + 120n, spec: { path: expiryPath } });
  record(expiryPath, "createJob (short expiry)", expiring.receipt);
  record(expiryPath, "setBudget", (await provider.setBudget(expiring.jobId, budget)).receipt);
  record(expiryPath, "fund", (await client.fund(expiring.jobId, budget)).receipt);
  await expectRevert("claimRefund before expiry", () => cranker.claimRefund(expiring.jobId), /NotExpired/);

  const cancelPath = "4-cancel-before-funding";
  const cancelled = await client.createJob({ provider: provider.account, expiredAt: (await now()) + 30n * 24n * 3600n, spec: { path: cancelPath } });
  record(cancelPath, "createJob", cancelled.receipt);
  record(cancelPath, "setBudget", (await provider.setBudget(cancelled.jobId, budget)).receipt);
  record(cancelPath, "reject (client, Open)", (await client.reject(cancelled.jobId)).receipt);

  const receivablePath = RECEIVABLE_PATH;
  const sold = await submittedJob(client, provider, budget, receivablePath);
  const asking = (budget * 9n) / 10n;
  stepped(5, record(receivablePath, `list (the receivable, at ${formatUnits(asking, 6)} of ${formatUnits(budget, 6)} USDC)`, (await provider.listClaim(sold, asking)).receipt));
  // square#30: the receivable sells only to a buyer the client's policy approved.
  const approved = approveBuyers([buyer.account]);
  stepped(5, record(receivablePath, "setBuyerRoot (the client approves the buyer)", (await client.setBuyerRoot(approved.root)).receipt));
  await expectRevert(
    "buy by an address the client did not approve",
    () => cranker.buyClaim(sold, approved.eligibilityOf(buyer.account), { autoApprove: false }),
    /BuyerNotEligible/,
  );
  stepped(5, record(receivablePath, "buy (the agent is paid now)", (await buyer.buyClaim(sold, approved.eligibilityOf(buyer.account))).receipt));
  const bound = await closeWindow(gate, client, sold, receivablePath, "the challenge window of the sold receivable");
  if (bound) stepped(7, bound);
  else stepped(7, note(receivablePath, "not on this stack: the hook holds no compliance module, so the release asked for no proof"));
  const paidToBuyer = await settle(receivablePath, "finalize (pays the buyer)", sold, () => cranker.finalize(sold), deployment, client);
  stepped(6, paidToBuyer.row);
  verified(gate, paidToBuyer, receivablePath);
  if (gate) stepped(7, note(receivablePath, `ReleaseVerified: the module read the proof at release and the payment fit the mandate`));
  const released = eventsNamed(paidToBuyer.events, "PaymentReleased")[0];
  if (released?.args.provider.toLowerCase() !== buyer.account.toLowerCase()) throw new Error("the buyer was not paid");
  const soldReputation = paidToBuyer.events.find((e) => e.contract === "SquareHook" && (e.eventName === "ReputationRecorded" || e.eventName === "ReputationSkipped" || e.eventName === "ReputationWriteFailed"));
  if (agentId !== undefined && soldReputation?.eventName !== "ReputationRecorded") throw new Error(`reputation was not written for agent ${agentId} on the sold receivable (${soldReputation?.eventName ?? "no reputation event"})`);
  stepped(8, note(receivablePath, `PaymentReleased ${formatUnits(released.args.amount, 6)} USDC to the buyer ${released.args.provider}; ${soldReputation ? `${soldReputation.eventName} for agent ${agentId ?? "none"}` : "no agent, no reputation written"}`));

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
    "## The eight steps",
    "",
    `square#31's flow, from the mandate to the payment with the receivable sold in between ([docs/design/mandate-to-payment.md](../design/mandate-to-payment.md)), read off this run: the rows above that are each step's evidence. The settlements were sent by ${keeperSettles ? "the keeper watching this chain (\`LIFECYCLE_FINALIZER=keeper\`); the runner bound the proofs and waited" : "this runner itself (\`LIFECYCLE_FINALIZER=self\`); on a chain a keeper watches, \`LIFECYCLE_FINALIZER=keeper\` makes the keeper's transaction the evidence"}.`,
    "",
    "| # | Step | Evidence | Transaction | Gas |",
    "|---|---|---|---|---|",
    ...EIGHT_STEPS.flatMap(([n, text]) => {
      const evidence = eight.get(n) ?? [];
      if (evidence.length === 0) return [`| ${n} | ${text} | nothing recorded on this run | | |`];
      return evidence.map((row, i) => `| ${i === 0 ? n : ""} | ${i === 0 ? text : ""} | ${row.step} | ${link(row.txHash)} | ${row.gasUsed === 0n ? "" : row.gasUsed.toString()} |`);
    }),
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
  await gate?.prover.close?.();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

export type { Address };
