import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toFunctionSelector, toFunctionSignature } from "viem";

const here = dirname(fileURLToPath(import.meta.url));
const abiDir = join(here, "..", "src", "abi");
const chainId = process.env["CHAIN_ID"] ?? "5042002";
const rpcUrl = process.env["RPC_URL"] ?? "https://rpc.testnet.arc.io";
const recordPath =
  process.env["SQUARE_DEPLOYMENT_FILE"] ?? join(here, "..", "..", "..", "contracts", "deployments", `${chainId}.json`);
const explorerApi = process.env["EXPLORER_API_URL"] ?? (chainId === "5042002" ? "https://testnet.arcscan.app/api" : "");

const abiModules = {
  SquareJob: "SquareJob.ts",
  KeeperEvaluator: "KeeperEvaluator.ts",
  Arbitration: "Arbitration.ts",
  ClaimMarket: "ClaimMarket.ts",
  SquareHook: "SquareHook.ts",
  PolicyRegistry: "PolicyRegistry.ts",
  ComplianceModule: "ComplianceModule.ts",
  ScreeningRegistry: "ScreeningRegistry.ts",
};

function abiOf(file) {
  const source = readFileSync(join(abiDir, file), "utf8");
  const opening = source.indexOf("[");
  const closing = source.lastIndexOf("]");
  if (opening === -1 || closing === -1) throw new Error(`${file} does not hold an ABI array`);
  return JSON.parse(source.slice(opening, closing + 1));
}

async function codeAt(address) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`eth_getCode ${address}: ${body.error.message}`);
  return String(body.result ?? "0x").slice(2).toLowerCase();
}

async function isVerified(address) {
  const response = await fetch(`${explorerApi}/v2/addresses/${address}`, { redirect: "follow" });
  if (!response.ok) return null;
  const body = await response.json();
  return body.is_verified === true;
}

const record = JSON.parse(readFileSync(recordPath, "utf8"));
const drifted = [];
const unverified = [];
const report = [];
let scanned = 0;

for (const [contract, file] of Object.entries(abiModules)) {
  const address = record[contract];
  if (typeof address !== "string") continue;
  const code = await codeAt(address);
  if (code.length === 0) {
    drifted.push(`${contract} @ ${address}: no code at that address`);
    continue;
  }
  const functions = abiOf(file).filter((entry) => entry.type === "function");
  const missing = [];
  for (const entry of functions) {
    scanned += 1;
    const selector = toFunctionSelector(entry).slice(2).toLowerCase();
    if (!code.includes(selector)) missing.push(`${toFunctionSignature(entry)} 0x${selector}`);
  }
  let verified = null;
  if (explorerApi !== "") {
    try {
      verified = await isVerified(address);
    } catch {
      verified = null;
    }
  }
  const explorerNote = verified === null ? "" : verified ? "  source verified" : "  source NOT verified";
  report.push(
    `${contract.padEnd(17)} ${address}  ${functions.length - missing.length}/${functions.length} selectors present${explorerNote}`,
  );
  for (const signature of missing) drifted.push(`${contract} @ ${address}: ${signature}`);
  if (verified === false) unverified.push(`${contract} @ ${address}`);
}

if (report.length === 0) {
  console.error(`error: ${recordPath} named no contract this check knows, refusing to report a pass`);
  process.exit(1);
}

console.log(`chain ${chainId} via ${rpcUrl}`);
for (const line of report) console.log(`  ${line}`);

if (unverified.length > 0) {
  console.error("");
  console.error(`${unverified.length} address(es) the record names are not verified on the explorer:`);
  for (const line of unverified) console.error(`  ${line}`);
  console.error("");
  console.error("Every deployment table in this repository links to those pages, and a reader gets");
  console.error("bytecode instead of source. contracts/script/deploy-arc-testnet.sh verifies as it");
  console.error("deploys; an existing address takes forge verify-contract --verifier blockscout.");
}

if (drifted.length > 0 || unverified.length > 0) {
  console.error("");
  console.error(`${drifted.length} selector(s) in packages/core are not in the deployed bytecode:`);
  for (const line of drifted) console.error(`  ${line}`);
  console.error("");
  console.error("The SDK, the keeper and the app call these and the chain does not answer them.");
  console.error("Either the stack is behind main and needs the redeploy in docs/deploy/README.md,");
  console.error("or the record names the wrong addresses.");
  process.exit(1);
}

console.log(
  `clean: ${scanned} selectors across ${report.length} contracts are in the deployed bytecode${explorerApi === "" ? "" : ", and every address is verified on the explorer"}`,
);
