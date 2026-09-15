// USDC from another testnet into Arc over CCTP V2, then into a Square job's
// escrow, written up as a report with every transaction hash (square#32).
//
//   npm run bridge
//
//   BRIDGE_SOURCE_RPC_URL      the source testnet: Ethereum Sepolia, Base Sepolia or Arbitrum Sepolia
//   BRIDGE_SOURCE_PRIVATE_KEY  the wallet that burns; holds the USDC and the chain's gas
//   ARC_PRIVATE_KEY            the wallet that delivers the attestation on Arc and funds the job; holds Arc gas
//   ARC_RPC_URL                default https://rpc.testnet.arc.io
//   BRIDGE_AMOUNT              decimal USDC to bridge; default 1
//   BRIDGE_FINALITY            fast (default) or standard
//   BRIDGE_RECIPIENT           who is minted to on Arc; default the Arc wallet
//   BRIDGE_JOB                 fund (default): create a job, the Arc wallet as client and provider, and fund it with what was minted; none: stop at the mint
//   BRIDGE_RESUME_HASH         a burn already sent: skip the burn, fetch its attestation and deliver it
//   BRIDGE_ATTESTATION_TIMEOUT_MS  how long to wait for Circle; default 30 minutes (a standard transfer from Ethereum takes ~15)
//   BRIDGE_REPORT              default docs/deploy/cctp-<date>.md
//   SQUARE_DEPLOYMENT_FILE     the Arc stack; default the constants in @squaresdk/core
//
// Each step is its own call in the SDK (depositForBurn, waitForAttestation,
// receiveMessage), which is what recovery is: a run that stopped after the
// burn is resumed with BRIDGE_RESUME_HASH, and a message someone else
// delivered is read as such and not sent again.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, formatUnits, http, parseUnits, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_EXPLORER_URL,
  ARC_TESTNET_RPC_URL,
  CCTP_TESTNET_DOMAINS,
  cctpDomainOf,
  cctpFees,
  createSquareClient,
  depositForBurn,
  deploymentFor,
  deploymentFromJson,
  erc20Abi,
  receiveMessage,
  waitForAttestation,
  type Attestation,
  type CctpDomain,
  type DepositForBurnResult,
  type ReceiveMessageResult,
} from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const env = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};
const need = (name: string): string => {
  const value = env(name);
  if (value === undefined) throw new Error(`${name} is not set`);
  return value;
};

const arcRpcUrl = env("ARC_RPC_URL") ?? ARC_TESTNET_RPC_URL;
const amount = parseUnits(env("BRIDGE_AMOUNT") ?? "1", 6);
const finality = (env("BRIDGE_FINALITY") ?? "fast") as "fast" | "standard";
const job = env("BRIDGE_JOB") ?? "fund";
const resumeHash = env("BRIDGE_RESUME_HASH") as Hex | undefined;
const date = new Date().toISOString().slice(0, 10);
const reportFile = env("BRIDGE_REPORT") ?? join(here, "..", "..", "..", "docs", "deploy", `cctp-${date}.md`);

const explorers: Record<number, string> = {
  11155111: "https://sepolia.etherscan.io",
  84532: "https://sepolia.basescan.org",
  421614: "https://sepolia.arbiscan.io",
  [ARC_TESTNET_CHAIN_ID]: ARC_TESTNET_EXPLORER_URL,
};
const link = (chainId: number, hash: Hex) => (explorers[chainId] ? `[\`${hash.slice(0, 10)}…\`](${explorers[chainId]}/tx/${hash})` : `\`${hash}\``);

const arcChain: Chain = defineChain({ id: ARC_TESTNET_CHAIN_ID, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [arcRpcUrl] } } });
const arcPublic = createPublicClient({ chain: arcChain, transport: http(arcRpcUrl) });

const lines: string[] = [];
const say = (line: string) => {
  console.log(line);
  lines.push(line);
};

async function main(): Promise<void> {
  const sourceRpcUrl = need("BRIDGE_SOURCE_RPC_URL");
  const sourceKey = need("BRIDGE_SOURCE_PRIVATE_KEY") as Hex;
  const arcKey = need("ARC_PRIVATE_KEY") as Hex;
  if (finality !== "fast" && finality !== "standard") throw new Error(`BRIDGE_FINALITY is fast or standard, not ${finality}`);
  if (job !== "fund" && job !== "none") throw new Error(`BRIDGE_JOB is fund or none, not ${job}`);
  const arcAccount = privateKeyToAccount(arcKey);
  const arcWallet = createWalletClient({ chain: arcChain, transport: http(arcRpcUrl), account: arcAccount });
  const recipient = (env("BRIDGE_RECIPIENT") as Address | undefined) ?? arcAccount.address;
  const probe = createPublicClient({ transport: http(sourceRpcUrl) });
  const sourceChainId = await probe.getChainId();
  const source: CctpDomain = cctpDomainOf(sourceChainId);
  const sourceChain: Chain = defineChain({ id: sourceChainId, name: source.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [sourceRpcUrl] } } });
  const sourcePublic = createPublicClient({ chain: sourceChain, transport: http(sourceRpcUrl) });
  const sourceAccount = privateKeyToAccount(sourceKey);
  const sourceWallet = createWalletClient({ chain: sourceChain, transport: http(sourceRpcUrl), account: sourceAccount });
  const arcChainId = await arcPublic.getChainId();
  if (arcChainId !== ARC_TESTNET_CHAIN_ID) throw new Error(`ARC_RPC_URL answers chain ${arcChainId}, not ${ARC_TESTNET_CHAIN_ID}`);

  say(`# CCTP V2 into Arc, ${date}\n`);
  say(`${source.name} (domain ${source.domain}) → Arc Testnet (domain ${CCTP_TESTNET_DOMAINS.arcTestnet.domain}), ${formatUnits(amount, 6)} USDC, ${finality} finality.`);
  say(`Burner \`${sourceAccount.address}\` on ${source.name}; recipient and deliverer \`${recipient}\` / \`${arcAccount.address}\` on Arc.\n`);

  const fees = await cctpFees(source.domain, CCTP_TESTNET_DOMAINS.arcTestnet.domain);
  say(`Fees the attestation service quotes: ${fees.map((f) => `${f.minimumFeeBps} bps at finality ${f.finalityThreshold}`).join(", ")}.\n`);

  const arcUsdc = CCTP_TESTNET_DOMAINS.arcTestnet.usdc;
  const arcBalance = () => arcPublic.readContract({ abi: erc20Abi, address: arcUsdc, functionName: "balanceOf", args: [recipient] });
  const arcBefore = await arcBalance();
  const started = Date.now();
  let burnHash: Hex;
  say(`| Step | Chain | Transaction | Gas |\n|---|---|---|---|`);
  if (resumeHash) {
    burnHash = resumeHash;
    say(`| depositForBurn | ${source.name} | ${link(sourceChainId, burnHash)} (sent earlier; resumed from it) | |`);
  } else {
    const burn: DepositForBurnResult = await depositForBurn({ publicClient: sourcePublic, walletClient: sourceWallet, amount, recipient, finality });
    burnHash = burn.hash;
    say(`| depositForBurn (${formatUnits(burn.amount, 6)} USDC, maxFee ${formatUnits(burn.maxFee, 6)}) | ${source.name} | ${link(sourceChainId, burn.hash)} | ${burn.receipt.gasUsed} |`);
  }

  const waitedFrom = Date.now();
  const attestation: Attestation = await waitForAttestation({
    sourceDomain: source.domain,
    transactionHash: burnHash,
    timeoutMs: Number(env("BRIDGE_ATTESTATION_TIMEOUT_MS") ?? 30 * 60_000),
    onPending: (status, delay) => console.log(`  attestation: ${status}${delay ? ` (${delay})` : ""}, ${Math.round((Date.now() - waitedFrom) / 1000)} s`),
  });
  const attestedAfter = Math.round((Date.now() - waitedFrom) / 1000);
  const fee = attestation.decoded.burn?.feeExecuted ?? 0n;
  say(`| attestation (nonce \`${attestation.eventNonce.slice(0, 10)}…\`, fee executed ${formatUnits(fee, 6)} USDC) | Circle | after ${attestedAfter} s | |`);

  const receive: ReceiveMessageResult = await receiveMessage({ publicClient: arcPublic, walletClient: arcWallet, message: attestation.message, attestation: attestation.attestation });
  if (receive.alreadyReceived) {
    say(`| receiveMessage | Arc Testnet | already delivered by another hand (nonce used) | |`);
  } else {
    say(`| receiveMessage (minted ${formatUnits(receive.minted?.amount ?? 0n, 6)} USDC to \`${receive.minted?.recipient}\`, fee ${formatUnits(receive.minted?.feeCollected ?? 0n, 6)}) | Arc Testnet | ${link(ARC_TESTNET_CHAIN_ID, receive.hash!)} | ${receive.receipt!.gasUsed} |`);
  }
  const arcAfter = await arcBalance();
  const minted = receive.minted?.amount ?? attestation.decoded.burn!.amount - fee;
  say(`\nUSDC of \`${recipient}\` on Arc: ${formatUnits(arcBefore, 6)} → ${formatUnits(arcAfter, 6)}. ${Math.round((Date.now() - started) / 1000)} s end to end.\n`);

  if (job === "fund") {
    const deploymentFile = env("SQUARE_DEPLOYMENT_FILE");
    const deployment = deploymentFile && existsSync(deploymentFile) ? deploymentFromJson(JSON.parse(readFileSync(deploymentFile, "utf8"))) : deploymentFor(ARC_TESTNET_CHAIN_ID);
    const client = createSquareClient({ publicClient: arcPublic, deployment, walletClient: arcWallet });
    // The Arc wallet is client and provider both: `setBudget` is the provider's call, and this runner holds one Arc key.
    // The kernel allows it (nothing in createJob compares the two), and the escrow is real either way.
    const providerAddress: Address = arcAccount.address;
    const latest = await arcPublic.getBlock();
    const created = await client.createJob({ provider: providerAddress, expiredAt: latest.timestamp + 86_400n, spec: { task: "funded with USDC bridged over CCTP V2", burn: burnHash } });
    const budget = minted;
    const budgeted = await client.setBudget(created.jobId, budget);
    const funded = await client.fund(created.jobId, budget);
    say(`| createJob (job ${created.jobId}, provider \`${providerAddress}\`) | Arc Testnet | ${link(ARC_TESTNET_CHAIN_ID, created.hash)} | ${created.receipt.gasUsed} |`);
    say(`| setBudget (${formatUnits(budget, 6)} USDC) | Arc Testnet | ${link(ARC_TESTNET_CHAIN_ID, budgeted.hash)} | ${budgeted.receipt.gasUsed} |`);
    say(`| fund | Arc Testnet | ${link(ARC_TESTNET_CHAIN_ID, funded.hash)} | ${funded.receipt.gasUsed} |`);
    const record = await client.getJobRecord(created.jobId);
    say(`\nJob ${created.jobId} is Funded (status ${record.status}) with ${formatUnits(record.budget, 6)} USDC that left ${source.name} as ${formatUnits(amount, 6)} USDC. It expires in a day; \`claimRefund\` returns the escrow to \`${arcAccount.address}\` after that, or the ordinary lifecycle settles it.`);
  }

  mkdirSync(dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, `${lines.join("\n")}\n`);
  console.log(`\nreport written to ${reportFile}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
