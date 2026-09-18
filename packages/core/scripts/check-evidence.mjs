import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, encodeAbiParameters, http, keccak256, parseAbiItem } from "viem";

const here = dirname(fileURLToPath(import.meta.url));
const abiDir = join(here, "..", "src", "abi");
const chainId = process.env["CHAIN_ID"] ?? "5042002";
const rpcUrl = process.env["RPC_URL"] ?? "https://rpc.testnet.arc.io";
const recordPath =
  process.env["SQUARE_DEPLOYMENT_FILE"] ?? join(here, "..", "..", "..", "contracts", "deployments", `${chainId}.json`);

const jobs = process.argv.slice(2).map((value) => {
  const id = BigInt(value);
  if (id <= 0n) throw new Error(`${value} is not a job id`);
  return id;
});

if (jobs.length === 0) {
  console.error("usage: node scripts/check-evidence.mjs <jobId> [<jobId>...]");
  console.error("");
  console.error("Reads the ERC-8004 validation record Square wrote for each job and checks it");
  console.error("against the settlement the chain actually performed. CHAIN_ID and RPC_URL");
  console.error("select the network; SQUARE_DEPLOYMENT_FILE overrides the address record.");
  process.exit(2);
}

function abiOf(file) {
  const source = readFileSync(join(abiDir, file), "utf8");
  const opening = source.indexOf("[");
  const closing = source.lastIndexOf("]");
  if (opening === -1 || closing === -1) throw new Error(`${file} does not hold an ABI array`);
  return JSON.parse(source.slice(opening, closing + 1));
}

const record = JSON.parse(readFileSync(recordPath, "utf8"));
const addressOf = (name) => {
  const found = record["contracts"]?.[name] ?? record[name];
  if (typeof found !== "string") throw new Error(`${recordPath} names no ${name}`);
  return found;
};

const hook = addressOf("SquareHook");
const validationRegistry = addressOf("ValidationRegistry");
const hookAbi = abiOf("SquareHook.ts");
const client = createPublicClient({ transport: http(rpcUrl) });

const EVIDENCE = parseAbiItem(
  "event EvidenceRecorded(uint256 indexed jobId, address indexed payee, uint256 amount, address token, bytes32 screening, uint8 complianceOutcome, uint8 screeningOutcome, bytes32 commitment)",
);

const STATUS = parseAbiItem(
  "function getValidationStatus(bytes32 requestHash) view returns (address, uint256, uint8, bytes32, string, uint256)",
);

const COMMITMENT_FIELDS = [
  { type: "uint256" },
  { type: "address" },
  { type: "uint256" },
  { type: "address" },
  { type: "bytes32" },
  { type: "uint8" },
  { type: "uint8" },
];

function commitmentOf(event) {
  return keccak256(
    encodeAbiParameters(COMMITMENT_FIELDS, [
      event.jobId,
      event.payee,
      event.amount,
      event.token,
      event.screening,
      event.complianceOutcome,
      event.screeningOutcome,
    ]),
  );
}

const fromBlock = process.env["FROM_BLOCK"] !== undefined
  ? BigInt(process.env["FROM_BLOCK"])
  : record["block"] !== undefined
    ? BigInt(record["block"])
    : 0n;

console.log(`chain ${chainId} via ${rpcUrl}`);
console.log(`hook ${hook}, validation registry ${validationRegistry}, from block ${fromBlock}`);
console.log("");

const problems = [];
let checked = 0;

for (const jobId of jobs) {
  const requestHash = await client.readContract({
    abi: hookAbi,
    address: hook,
    functionName: "validationOf",
    args: [jobId],
  });
  if (/^0x0+$/.test(requestHash)) {
    console.log(`  job ${jobId}  no validation request was opened, so no record was written`);
    continue;
  }

  const logs = await client.getLogs({ address: hook, event: EVIDENCE, args: { jobId }, fromBlock, toBlock: "latest" });
  if (logs.length === 0) {
    problems.push(`job ${jobId} has a validation request but the chain carries no EvidenceRecorded for it`);
    continue;
  }
  const event = logs[logs.length - 1].args;

  const recomputed = commitmentOf(event);
  if (recomputed !== event.commitment) {
    problems.push(`job ${jobId}: the event's own fields hash to ${recomputed}, not to the ${event.commitment} it carries`);
  }

  const [, , response, responseHash] = await client.readContract({
    abi: [STATUS],
    address: validationRegistry,
    functionName: "getValidationStatus",
    args: [requestHash],
  });
  if (responseHash !== event.commitment) {
    problems.push(`job ${jobId}: the registry holds ${responseHash} and the chain's own event says ${event.commitment}`);
  }

  const [payee, amount, token] = await client.readContract({
    abi: hookAbi,
    address: hook,
    functionName: "settlementFacts",
    args: [jobId],
  });
  if (payee.toLowerCase() !== event.payee.toLowerCase()) {
    problems.push(`job ${jobId}: the record names ${event.payee} and the settlement paid ${payee}`);
  }
  if (amount !== event.amount) {
    problems.push(`job ${jobId}: the record claims ${event.amount} and the settlement paid ${amount}`);
  }
  if (token.toLowerCase() !== event.token.toLowerCase()) {
    problems.push(`job ${jobId}: the record names token ${event.token} and the kernel pays in ${token}`);
  }
  const paid = event.amount > 0n;
  if ((response === 100) !== paid) {
    problems.push(`job ${jobId}: the response is ${response} and the amount is ${event.amount}`);
  }

  checked += 1;
  const units = Number(event.amount) / 1_000_000;
  console.log(
    `  job ${jobId}  ${response === 100 ? "paid" : "unpaid"}  ${units} USDC to ${event.payee}  commitment ${event.commitment.slice(0, 10)}…`,
  );
}

console.log("");

if (problems.length > 0) {
  const annotate = process.env["GITHUB_ACTIONS"] ? "::error::" : "error: ";
  for (const problem of problems) console.error(`${annotate}${problem}`);
  console.error(
    `${annotate}${problems.length} record(s) disagree with the chain. A Square reputation record is meant to be checkable against the payment that produced it; one that is not is worth no more than an unbacked rating.`,
  );
  process.exit(1);
}

console.log(
  `clean: ${checked} record(s) match the settlement that produced them, in amount, payee and token`,
);
