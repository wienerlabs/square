import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const contractsOut = join(here, "..", "..", "..", "contracts", "out");
const target = join(here, "..", "src", "abi");
mkdirSync(target, { recursive: true });

const contracts = [
  ["SquareJob", "squareJobAbi"],
  ["KeeperEvaluator", "keeperEvaluatorAbi"],
  ["Arbitration", "arbitrationAbi"],
  ["ClaimMarket", "claimMarketAbi"],
  ["SquareHook", "squareHookAbi"],
];

const erc20 = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "event", name: "Transfer", inputs: [{ name: "from", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "value", type: "uint256", indexed: false }] },
];

const exportsList = [];
for (const [name, exportName] of contracts) {
  const artifact = JSON.parse(readFileSync(join(contractsOut, `${name}.sol`, `${name}.json`), "utf8"));
  const file = `export const ${exportName} = ${JSON.stringify(artifact.abi, null, 2)} as const;\n`;
  writeFileSync(join(target, `${name}.ts`), file);
  exportsList.push(`export { ${exportName} } from "./${name}.js";`);
}
writeFileSync(join(target, "erc20.ts"), `export const erc20Abi = ${JSON.stringify(erc20, null, 2)} as const;\n`);
exportsList.push(`export { erc20Abi } from "./erc20.js";`);
writeFileSync(join(target, "index.ts"), exportsList.join("\n") + "\n");
console.log(`wrote ${contracts.length + 1} ABI modules to ${target}`);
