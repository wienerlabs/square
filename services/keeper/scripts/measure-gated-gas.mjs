import { readFileSync } from "node:fs";
import { createPublicClient, createTestClient, createWalletClient, http, parseUnits } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { createSquareClient, deploymentFromJson, hashDeliverable } from "@squaresdk/core";

const rpcUrl = process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8546";
const deployment = deploymentFromJson(JSON.parse(readFileSync("../../../contracts/deployments/31337.json", "utf8")));
const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl) });
const account = (i) => mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: i });
const actor = (i) =>
  createSquareClient({ publicClient, deployment, walletClient: createWalletClient({ chain: foundry, transport: http(rpcUrl), account: account(i) }) });

const client = actor(1);
const provider = actor(2);
const cranker = actor(7);

console.log("complianceModule", await cranker.complianceModule());
console.log("tolerance", await cranker.complianceTolerance());
console.log("gasPrice", await publicClient.getGasPrice());
const block = await publicClient.getBlock();
console.log("baseFeePerGas", block.baseFeePerGas);

async function submitted(budget) {
  const latest = await publicClient.getBlock();
  const { jobId } = await client.createJob({ provider: provider.account, expiredAt: latest.timestamp + 30n * 24n * 3600n, spec: { measure: Date.now() } });
  await provider.setBudget(jobId, budget);
  await client.fund(jobId, budget);
  await provider.submit({ jobId, deliverable: hashDeliverable(`measure ${jobId}`), agentId: 1n });
  return jobId;
}

const jobId = await submitted(parseUnits("50", 6));
const end = await client.challengeEndsAt(jobId);
const latest = await publicClient.getBlock();
await testClient.increaseTime({ seconds: Number(BigInt(end) - latest.timestamp + 1n) });
await testClient.mine({ blocks: 1 });
console.log("previewRelease, no proof bound:", await cranker.previewRelease({ jobId, payee: provider.account, amount: parseUnits("49", 6), client: client.account, proof: "0x" }));
console.log("complianceProofOf:", await cranker.complianceProofOf(jobId));
const result = await cranker.finalize(jobId);
console.log("gated finalize, no proof bound, gasUsed:", result.receipt.gasUsed);
console.log("effectiveGasPrice:", result.receipt.effectiveGasPrice);
for (const event of result.events) console.log("event", event.contract, event.eventName, JSON.stringify(event.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
