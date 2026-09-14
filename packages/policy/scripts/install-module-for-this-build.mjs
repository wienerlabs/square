#!/usr/bin/env node
// Install a compliance module on a local stack, keyed to the proving key the
// prover beside it holds.
//
// DeployLocal.s.sol deploys src/Groth16Verifier.sol, whose constants come
// from one particular key, and circuits/scripts/build.mjs draws fresh phase-2
// entropy on every build, so the verifier on a dev chain and the key in
// services/prover/artifacts agree only by accident. contracts/README.md
// "Deployed" explains why that is the correct state before the ceremony
// (square#16); the six refusal scenarios work around it by compiling the
// repository's verifier with this build's constants, and so does this script,
// the same way, for the stack the SDK's anvil suites run against:
//
//   1. src/generated/VerifierForThisBuild.sol from services/prover/artifacts/payment_vk.json
//   2. forge build
//   3. deploy it, deploy ComplianceModule(verifier, registry, kernel, owner, tolerance),
//      module.setHook(hook), registry.setSpender(module, true), hook.setComplianceModule(module)
//
// After it, every release on the stack is proof gated, which is what
// packages/policy, the CLI's policy commands, square_hire and the hosted
// agent's delegation are tested against (square#335).
//
//   ANVIL_RPC_URL           http://127.0.0.1:8545
//   SQUARE_DEPLOYMENT_FILE  contracts/deployments/31337.json; the module and verifier are written back into it
//   PROVER_ARTIFACTS_DIR    services/prover/artifacts
//   DEPLOYER_PRIVATE_KEY    anvil's first account (from its mnemonic) by default; must own the registry and the hook
//   TOLERANCE_SECONDS       3600, what DeployLocal uses
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, zeroAddress } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const contracts = join(repo, "contracts");
const rpcUrl = process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8545";
const deploymentFile = process.env.SQUARE_DEPLOYMENT_FILE ?? join(contracts, "deployments", "31337.json");
const artifacts = process.env.PROVER_ARTIFACTS_DIR ?? join(repo, "services", "prover", "artifacts");
const vkFile = join(artifacts, "payment_vk.json");
const tolerance = BigInt(process.env.TOLERANCE_SECONDS ?? "3600");
const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

if (!existsSync(vkFile)) {
  console.error(`no verification key at ${vkFile}; build the circuit (circuits: npm run build) and copy the artifacts to the prover first`);
  process.exit(1);
}
const deployment = JSON.parse(readFileSync(deploymentFile, "utf8"));
for (const key of ["SquareJob", "SquareHook", "ClaimMarket"]) {
  if (!deployment[key]) {
    console.error(`${deploymentFile} has no ${key}`);
    process.exit(1);
  }
}

// 1. The verifier for this key, as contracts/script/refusal-scenarios.mjs writes it.
const generatedDir = join(contracts, "src", "generated");
const generated = join(generatedDir, "VerifierForThisBuild.sol");
const source = readFileSync(join(contracts, "src", "Groth16Verifier.sol"), "utf8");
const constants = execFileSync(process.execPath, [join(contracts, "script", "verifier-constants.mjs"), vkFile], { encoding: "utf8" }).trimEnd();
const first = source.indexOf("    uint256 private constant ALPHA_X");
const lastIc = source.lastIndexOf("    uint256 private constant IC");
if (first < 0 || lastIc < 0) throw new Error("could not find the key constants in src/Groth16Verifier.sol");
const end = source.indexOf("\n", lastIc) + 1;
mkdirSync(generatedDir, { recursive: true });
writeFileSync(
  generated,
  (source.slice(0, first) + constants + "\n" + source.slice(end))
    .replace("contract Groth16Verifier {", "contract VerifierForThisBuild {")
    .replace(/from "\.\/interfaces\//g, 'from "../interfaces/'),
);
console.log(`wrote ${generated}`);

// 2. Compile it.
execFileSync("forge", ["build"], { cwd: contracts, stdio: "inherit", timeout: 600_000 });

// 3. Deploy and wire.
const artifact = (file, name) => {
  const json = JSON.parse(readFileSync(join(contracts, "out", file, `${name}.json`), "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
};
const chainId = Number(deployment.chainId ?? 31337);
const chain = defineChain({ id: chainId, name: `chain ${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const account = deployerKey ? privateKeyToAccount(deployerKey) : mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 0 });
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const wallet = createWalletClient({ chain, transport: http(rpcUrl), account });

async function send(label, request) {
  const hash = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted in ${hash}`);
  console.log(`${label}: ${hash}`);
  return receipt;
}
async function deploy(label, file, name, args) {
  const { abi, bytecode } = artifact(file, name);
  const hash = await wallet.deployContract({ abi, bytecode, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`${label} did not deploy`);
  console.log(`${label}: ${receipt.contractAddress}`);
  return { address: getAddress(receipt.contractAddress), abi };
}

const kernel = getAddress(deployment.SquareJob);
const hookAddress = getAddress(deployment.SquareHook);
const market = artifact("ClaimMarket.sol", "ClaimMarket");
const registryAddress = getAddress(await publicClient.readContract({ abi: market.abi, address: getAddress(deployment.ClaimMarket), functionName: "policyRegistry" }));
const registry = artifact("PolicyRegistry.sol", "PolicyRegistry");
const hook = artifact("SquareHook.sol", "SquareHook");

const verifier = await deploy("VerifierForThisBuild", "VerifierForThisBuild.sol", "VerifierForThisBuild", []);
const module = await deploy("ComplianceModule", "ComplianceModule.sol", "ComplianceModule", [verifier.address, registryAddress, kernel, account.address, tolerance]);
await send("module.setHook", { abi: module.abi, address: module.address, functionName: "setHook", args: [hookAddress] });
await send("registry.setSpender", { abi: registry.abi, address: registryAddress, functionName: "setSpender", args: [module.address, true] });
const previous = await publicClient.readContract({ abi: hook.abi, address: hookAddress, functionName: "complianceModule" });
if (previous !== zeroAddress) console.log(`replacing the module at ${previous}`);
await send("hook.setComplianceModule", { abi: hook.abi, address: hookAddress, functionName: "setComplianceModule", args: [module.address] });

deployment.ComplianceModule = module.address;
deployment.Groth16Verifier = verifier.address;
deployment.PolicyRegistry = registryAddress;
writeFileSync(deploymentFile, JSON.stringify(deployment, null, 2) + "\n");
console.log(`module ${module.address} installed on the hook at ${hookAddress}, tolerance ${tolerance}s; recorded in ${deploymentFile}`);
