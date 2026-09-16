import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import * as p from "@clack/prompts";
import { approveBuyers, buyerListFrom, deploymentFromJson, type BuyerEntry } from "@squaresdk/core";
import {
  ComplianceDuty,
  bindComplianceProof,
  decodeComplianceProof,
  newPolicy,
  parsePolicy,
  policyCommitment,
  policyToJson,
  proofState,
  releaseFacts,
  signalsOf,
  type DutyEvent,
  type Policy,
  type Weekday,
} from "@squaresdk/policy";
import { createLocalProver, type LocalProver } from "@squaresdk/policy/node";
import { formatUnits, getAddress, isAddress, parseUnits, type Address, type Hex } from "viem";
import { explorerTxUrl, type Network } from "../core/chains.js";
import { loadConfig, resolveNetwork } from "../core/config.js";
import { SquareError, ValidationError } from "../core/errors.js";
import { log } from "../core/logger.js";
import { deploymentForNetwork, readOnlySquare, signingSquare } from "../core/square.js";
import { c } from "../core/theme.js";
import { keystoreAddress } from "../core/unlock.js";

/**
 * `square policy`: the institution's side of the compliance gate (square#338,
 * square#335). A policy is a file the prover's vocabulary describes; its
 * commitment goes on chain with `commit`, its buyer list with `buyers`, and
 * the proof that a release fits it is bound to a job with `prove` or kept
 * current by `watch`. The file holds the policy's secret and never leaves
 * this process: the proof is made here, from the circuit's files on this
 * machine (square#347, docs/decisions/prover-trust-boundary.md).
 */
interface NetworkOpts {
  chainId?: number;
  rpc?: string;
  registry?: string;
  deployment?: string;
}

const ZERO32 = `0x${"0".repeat(64)}`;
const USDC = /^\d+(\.\d{1,6})?$/;

function networkOptions(command: Command): Command {
  return command
    .option("--chain-id <n>", "Override the chain id", (v) => Number(v))
    .option("--rpc <url>", "Override the RPC endpoint")
    .option("--registry <address>", "Override the IdentityRegistry address")
    .option("--deployment <file>", "A contracts/deployments/<chainId>.json (or set SQUARE_DEPLOYMENT_FILE)");
}

/**
 * The chain and the deployment. A deployment file names the chain and its
 * IdentityRegistry, so with one given (or SQUARE_DEPLOYMENT_FILE set) neither
 * `--chain-id` nor `--registry` is needed for a local stack; `--rpc` still is,
 * unless the chain is one the CLI knows.
 */
async function target(opts: NetworkOpts): Promise<{ network: Network; deployment: ReturnType<typeof deploymentForNetwork> }> {
  const config = await loadConfig();
  const file = opts.deployment ?? process.env["SQUARE_DEPLOYMENT_FILE"]?.trim();
  const fromFile = file && existsSync(file) ? deploymentFromJson(JSON.parse(readFileSync(file, "utf8"))) : undefined;
  const network = resolveNetwork(config, {
    chainId: opts.chainId ?? fromFile?.chainId,
    rpc: opts.rpc,
    registry: opts.registry ?? fromFile?.identityRegistry,
  });
  return { network, deployment: deploymentForNetwork(network, opts.deployment) };
}

function usdc(value: string, label: string): bigint {
  if (!USDC.test(value)) throw new ValidationError(`${label} has to be decimal USDC with at most six decimals, like 25.50`);
  return parseUnits(value, 6);
}

function address(value: string, label: string): Address {
  if (!isAddress(value)) throw new ValidationError(`${label}: ${value} is not a 20-byte address`);
  return getAddress(value);
}

function readPolicy(file: string): Policy {
  if (!existsSync(file)) throw new ValidationError(`No policy file at ${file}`, "square policy init writes one.");
  try {
    return parsePolicy(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) throw new ValidationError(`${file} is not JSON`);
    throw new ValidationError(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function confirm(yes: boolean | undefined, message: string): Promise<boolean> {
  if (yes) return true;
  if (!process.stderr.isTTY) throw new SquareError("Confirmation required", undefined, "Re-run with --yes from a non-interactive context.");
  log.blank();
  const ok = await p.confirm({ message, initialValue: false });
  if (p.isCancel(ok) || ok === false) {
    p.cancel("Cancelled. Nothing was sent.");
    return false;
  }
  return true;
}

function txLine(network: Network, hash: Hex): string {
  return explorerTxUrl(network, hash) ?? hash;
}

// ---------------------------------------------------------------- policy init

interface InitOpts extends NetworkOpts {
  out: string;
  operator?: string;
  daily: string;
  perTx: string;
  category: string[];
  token: string[];
  block: string[];
  days?: string;
  hours?: string;
  force?: boolean;
  json?: boolean;
}

function initCommand(): Command {
  return networkOptions(
    new Command("init")
      .description("Write a policy file with a fresh id and secret salt, and print its commitment")
      .requiredOption("--daily <usdc>", "The day's ceiling, decimal USDC")
      .requiredOption("--per-tx <usdc>", "The ceiling per release, decimal USDC")
      .option("--category <id>", "A capability this policy pays for (repeatable, up to eight)", (v: string, all: string[]) => [...all, v], [])
      .option("--token <address>", "A token the policy pays in (repeatable); the chain's USDC when omitted", (v: string, all: string[]) => [...all, v], [])
      .option("--block <address>", "A payee the policy refuses (repeatable, up to ten)", (v: string, all: string[]) => [...all, v], [])
      .option("--days <list>", "Weekdays a release may fall on, comma-separated (with --hours)")
      .option("--hours <start-end>", "UTC hours a release may fall in, like 9-17 (with --days)")
      .option("--operator <address>", "The institution's address; the wallet's when omitted")
      .option("--out <file>", "Where to write the policy", "policy.json")
      .option("--force", "Overwrite an existing file")
      .option("--json", "Machine-readable result"),
  ).action(async (opts: InitOpts) => {
    if (existsSync(opts.out) && !opts.force) {
      throw new ValidationError(`${opts.out} exists`, "A policy file holds a secret; pass --force to replace it, and recommit afterwards.");
    }
    if ((opts.days === undefined) !== (opts.hours === undefined)) throw new ValidationError("--days and --hours go together");
    if (opts.category.length === 0) throw new ValidationError("At least one --category: the capabilities this policy pays for");
    const { deployment } = await target(opts);
    const operator = opts.operator !== undefined ? address(opts.operator, "--operator") : await walletAddress();
    let timeRestriction;
    if (opts.days !== undefined && opts.hours !== undefined) {
      const match = /^(\d{1,2})-(\d{1,2})$/.exec(opts.hours.trim());
      if (!match) throw new ValidationError("--hours has to be start-end in UTC hours, like 9-17");
      timeRestriction = {
        // newPolicy validates the names; a misspelt weekday is refused there, by name.
        allowed_days: opts.days.split(",").map((d) => d.trim().toLowerCase() as Weekday),
        allowed_hours_start: Number(match[1]),
        allowed_hours_end: Number(match[2]),
      };
    }
    const policy = newPolicy({
      operator,
      maxDailySpend: usdc(opts.daily, "--daily"),
      maxPerTransaction: usdc(opts.perTx, "--per-tx"),
      categories: opts.category,
      tokens: opts.token.length > 0 ? opts.token.map((t) => address(t, "--token")) : [deployment.usdc],
      blocked: opts.block.map((b) => address(b, "--block")),
      timeRestriction,
    });
    // Owner-only: the file is the policy's secret.
    writeFileSync(opts.out, policyToJson(policy), { mode: 0o600 });
    const commitment = await policyCommitment(policy);
    if (opts.json) {
      log.out(JSON.stringify({ file: opts.out, policyId: policy.policy_id, operator, commitment: commitment.hex, dailyLimit: policy.max_daily_spend }, null, 2));
    } else {
      log.blank();
      log.success(`Wrote ${opts.out} (mode 0600). It holds the policy's secret: keep it, back it up, and do not commit it.`);
      log.field("policy id", policy.policy_id);
      log.field("operator", operator);
      log.field("daily", `${opts.daily} USDC`);
      log.field("per release", `${opts.perTx} USDC`);
      log.field("categories", policy.allowed_endpoint_categories.join(", "));
      log.field("commitment", commitment.hex);
      log.blank();
      log.raw(`  Next: ${c.bold(`square policy commit ${opts.out}`)} puts the commitment on chain.`);
      log.blank();
    }
  });
}

async function walletAddress(): Promise<Address> {
  const fromEnv = process.env["SQUARE_PRIVATE_KEY"]?.trim();
  if (fromEnv) {
    const { importPrivateKey } = await import("../core/wallet.js");
    return importPrivateKey(fromEnv).address as Address;
  }
  const stored = await keystoreAddress();
  if (stored === null) throw new SquareError("No wallet to name as the operator", undefined, "Pass --operator <address>, or square login first.");
  return getAddress(stored);
}

// -------------------------------------------------------------- policy commit

interface CommitOpts extends NetworkOpts {
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

function commitCommand(): Command {
  return networkOptions(
    new Command("commit")
      .description("Commit a policy file on chain: setPolicy(commitment, daily limit) from the wallet")
      .argument("<file>", "The policy file")
      .option("--dry-run", "Compute and print the commitment; send nothing")
      .option("-y, --yes", "Skip the confirmation")
      .option("--json", "Machine-readable result"),
  ).action(async (file: string, opts: CommitOpts) => {
    const policy = readPolicy(file);
    const commitment = await policyCommitment(policy);
    const dailyLimit = BigInt(policy.max_daily_spend);
    const { network, deployment } = await target(opts);
    const reader = readOnlySquare(network, deployment);
    const current = await reader.policyOf(policy.operator_id);
    const same = current.commitment.toLowerCase() === commitment.hex.toLowerCase();
    if (!opts.json) {
      log.blank();
      log.field("network", `${network.name} (${network.chainId})`);
      log.field("operator", policy.operator_id);
      log.field("commitment", commitment.hex);
      log.field("daily limit", `${formatUnits(dailyLimit, 6)} USDC`);
      log.field("on chain now", current.commitment === ZERO32 ? "no policy" : `${current.commitment}${same ? " (this one)" : ""}, limit ${formatUnits(current.dailyLimit, 6)} USDC, epoch ${current.epoch}`);
    }
    if (opts.dryRun) {
      if (opts.json) log.out(JSON.stringify({ dryRun: true, operator: policy.operator_id, commitment: commitment.hex, dailyLimit: dailyLimit.toString(), committed: same }, null, 2));
      else {
        log.blank();
        log.success("Dry run — nothing was signed or sent.");
      }
      return;
    }
    if (same && current.dailyLimit === dailyLimit) {
      if (opts.json) log.out(JSON.stringify({ status: "unchanged", commitment: commitment.hex, epoch: current.epoch.toString() }, null, 2));
      else log.success("The chain already holds this commitment and limit; nothing to send.");
      return;
    }
    if (!(await confirm(opts.yes, `Commit this policy on ${network.name}? Every commit starts a new epoch.`))) return;
    const { client, address: signer } = await signingSquare(network, deployment, "Commit a policy");
    if (signer.toLowerCase() !== policy.operator_id.toLowerCase()) {
      throw new SquareError(`The wallet is ${signer}, the policy's operator is ${policy.operator_id}`, undefined, "A policy is committed by the address it names; write one for this wallet, or unlock that one.");
    }
    const result = await client.setPolicy(commitment.hex, dailyLimit);
    const after = await client.policyOf(policy.operator_id);
    if (opts.json) log.out(JSON.stringify({ status: "committed", transaction: result.hash, commitment: commitment.hex, dailyLimit: dailyLimit.toString(), epoch: after.epoch.toString() }, null, 2));
    else {
      log.blank();
      log.success(`Committed in ${txLine(network, result.hash)} (epoch ${after.epoch}).`);
      log.blank();
    }
  });
}

// ---------------------------------------------------------------- policy show

interface ShowOpts extends NetworkOpts {
  file?: string;
  json?: boolean;
}

function showCommand(): Command {
  return networkOptions(
    new Command("show")
      .description("What the chain holds for a poster: the commitment, the daily limit, today's counter, the buyer list root")
      .argument("[poster]", "The poster's address; the wallet's when omitted")
      .option("--file <policy.json>", "Also say whether this file is the policy on chain")
      .option("--json", "Machine-readable result"),
  ).action(async (poster: string | undefined, opts: ShowOpts) => {
    const { network, deployment } = await target(opts);
    const who = poster !== undefined ? address(poster, "poster") : await walletAddress();
    const reader = readOnlySquare(network, deployment);
    const [policy, spent, root, module] = await Promise.all([reader.policyOf(who), reader.spentToday(who), reader.buyerRootOf(who), reader.complianceModule()]);
    const file = opts.file !== undefined ? readPolicy(opts.file) : undefined;
    const fileCommitment = file ? (await policyCommitment(file)).hex : undefined;
    const matches = fileCommitment === undefined ? undefined : fileCommitment.toLowerCase() === policy.commitment.toLowerCase();
    const remaining = policy.dailyLimit > spent ? policy.dailyLimit - spent : 0n;
    if (opts.json) {
      log.out(
        JSON.stringify(
          {
            poster: who,
            commitment: policy.commitment,
            committed: policy.commitment !== ZERO32,
            dailyLimit: policy.dailyLimit.toString(),
            spentToday: spent.toString(),
            remainingToday: remaining.toString(),
            epoch: policy.epoch.toString(),
            updatedAt: policy.updatedAt.toString(),
            buyerRoot: root,
            complianceModule: module,
            ...(fileCommitment !== undefined ? { file: opts.file, fileCommitment, fileMatches: matches } : {}),
          },
          null,
          2,
        ),
      );
      return;
    }
    log.blank();
    log.field("poster", who);
    log.field("network", `${network.name} (${network.chainId})`);
    if (policy.commitment === ZERO32) log.field("policy", "none committed");
    else {
      log.field("commitment", policy.commitment);
      log.field("daily limit", `${formatUnits(policy.dailyLimit, 6)} USDC`);
      log.field("spent today", `${formatUnits(spent, 6)} USDC (${formatUnits(remaining, 6)} left)`);
      log.field("epoch", `${policy.epoch}, since ${new Date(Number(policy.updatedAt) * 1000).toISOString()}`);
    }
    log.field("buyer list", root === ZERO32 ? "nobody approved" : root);
    log.field("gate", module === null ? "no module installed on the hook: releases are not proof gated" : `module ${module}: every release needs a proof`);
    if (file && fileCommitment !== undefined) log.field(opts.file ?? "file", matches ? "is the policy on chain" : `differs: it commits to ${fileCommitment}`);
    log.blank();
  });
}

// -------------------------------------------------------------- policy buyers

interface BuyersSetOpts extends NetworkOpts {
  out: string;
  yes?: boolean;
  json?: boolean;
}

interface BuyersEntryOpts {
  json?: boolean;
}

function buyersCommand(): Command {
  const buyers = new Command("buyers").description("The poster's approved-buyer list: publish its root, issue a buyer its entry");
  buyers.addCommand(
    networkOptions(
      new Command("set")
        .description("Approve these buyers: publish the list's root with setBuyerRoot and keep the entries in a file")
        .argument("<address...>", "The buyers")
        .option("--out <file>", "Where the entries (salts) are kept; issue from it with `buyers entry`", "buyers.json")
        .option("-y, --yes", "Skip the confirmation")
        .option("--json", "Machine-readable result"),
    ).action(async (addresses: string[], opts: BuyersSetOpts) => {
      const list = approveBuyers(addresses.map((a) => address(a, "buyer")));
      const { network, deployment } = await target(opts);
      if (!opts.json) {
        log.blank();
        log.field("buyers", `${list.entries.length}`);
        log.field("root", list.root);
        log.field("entries", `${opts.out} (each buyer's salt; the poster keeps it)`);
      }
      if (!(await confirm(opts.yes, `Publish this buyer list on ${network.name}? It replaces the list on chain.`))) return;
      const { client, address: signer } = await signingSquare(network, deployment, "Publish a buyer list");
      const result = await client.setBuyerRoot(list.root);
      writeFileSync(opts.out, JSON.stringify({ poster: signer, root: list.root, entries: list.entries }, null, 2) + "\n", { mode: 0o600 });
      if (opts.json) log.out(JSON.stringify({ status: "published", transaction: result.hash, root: list.root, entries: opts.out, buyers: list.entries.map((e) => e.buyer) }, null, 2));
      else {
        log.blank();
        log.success(`Published in ${txLine(network, result.hash)}; entries in ${opts.out} (mode 0600).`);
        log.raw(`  Issue a buyer its entry with ${c.bold(`square policy buyers entry ${opts.out} <address>`)}.`);
        log.blank();
      }
    }),
  );
  buyers.addCommand(
    new Command("entry")
      .description("A buyer's entry from the kept list: what it pastes into the purchase, {salt, proof, buyer}")
      .argument("<file>", "The entries file `buyers set` wrote")
      .argument("<address>", "The buyer")
      .option("--json", "Only the entry, on stdout (the default output is the entry too)")
      .action(async (file: string, buyer: string, _opts: BuyersEntryOpts) => {
        if (!existsSync(file)) throw new ValidationError(`No entries file at ${file}`);
        const kept = JSON.parse(readFileSync(file, "utf8")) as { root?: string; entries?: BuyerEntry[] };
        if (!Array.isArray(kept.entries)) throw new ValidationError(`${file} holds no entries`);
        const list = buyerListFrom(kept.entries);
        const who = address(buyer, "buyer");
        const eligibility = list.eligibilityOf(who);
        log.out(JSON.stringify({ buyer: who, salt: eligibility.salt, proof: eligibility.proof, root: list.root }, null, 2));
      }),
  );
  return buyers;
}

// --------------------------------------------------------- policy prove/watch

const ARTIFACTS_OPTION = "--artifacts <dir>";
const ARTIFACTS_HELP = "The circuit's payment.wasm, payment.zkey and payment_vk.json; the proof is made on this machine (or set SQUARE_PROVER_ARTIFACTS)";

/** The proving directory: the flag, else SQUARE_PROVER_ARTIFACTS. The proof is made in this process, so the policy never leaves it (square#347). */
function localProver(artifacts: string | undefined): LocalProver {
  const dir = artifacts ?? process.env["SQUARE_PROVER_ARTIFACTS"]?.trim();
  if (!dir) throw new ValidationError("name the circuit's files with --artifacts <dir> or SQUARE_PROVER_ARTIFACTS: the proof is made on this machine, from payment.wasm, payment.zkey and payment_vk.json");
  return createLocalProver({ artifacts: dir });
}

interface ProveOpts extends NetworkOpts {
  file: string;
  artifacts?: string;
  category: string;
  release?: boolean;
  bindRefusal?: boolean;
  json?: boolean;
}

function proveCommand(): Command {
  return networkOptions(
    new Command("prove")
      .description("Prove that a job's release fits the policy and bind the proof to the job; with --release, crank it too once its window has closed")
      .argument("<jobId>", "A job this wallet is the client of")
      .requiredOption("--file <policy.json>", "The policy file")
      .option(ARTIFACTS_OPTION, ARTIFACTS_HELP)
      .requiredOption("--category <id>", "The capability the job bought; one of the policy's categories")
      .option("--release", "Finalize the job after binding, if its challenge window has closed")
      .option("--bind-refusal", "When the policy refuses the release, bind the refusing proof anyway: the module refuses it at release and the net returns to this wallet (a job with no proof does not settle)")
      .option("--json", "Machine-readable result"),
  ).action(async (jobId: string, opts: ProveOpts) => {
    if (!/^\d+$/.test(jobId)) throw new ValidationError(`${jobId} is not a job id`);
    const policy = readPolicy(opts.file);
    const prover = localProver(opts.artifacts);
    try {
      await prove(jobId, policy, prover, opts);
    } finally {
      await prover.close();
    }
  });
}

async function prove(jobId: string, policy: Policy, prover: LocalProver, opts: ProveOpts): Promise<void> {
  const { network, deployment } = await target(opts);
  const { client } = await signingSquare(network, deployment, `Bind a proof to job ${jobId}`);
  const id = BigInt(jobId);
  if (!opts.release) {
    const outcome = await bindComplianceProof({ client, policy, prover, jobId: id, category: opts.category, bindRefusal: opts.bindRefusal === true });
    // With --json the outcome is on stdout either way; a refusal still exits non-zero.
    if (opts.json) log.out(JSON.stringify(outcome, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    if (outcome.bound) {
      if (!opts.json) {
        log.blank();
        if (outcome.verdict === "refusal") {
          log.warn(`The policy refuses this release (${(outcome.violated ?? ["rules unknown"]).join(", ")}); the refusal is bound to job ${jobId} in ${txLine(network, outcome.transaction)}. The module refuses it at release and the net returns to this wallet.`);
        } else {
          log.success(`Proof bound to job ${jobId} in ${txLine(network, outcome.transaction)}: payee ${outcome.facts.payee}, net ${formatUnits(outcome.facts.amount, 6)} USDC, counter ${formatUnits(outcome.facts.dailySpentBefore, 6)} USDC.`);
        }
        log.blank();
      }
    } else if (outcome.reason === "not-compliant") {
      throw new SquareError(
        `The policy does not allow this release: ${(outcome.violated ?? ["rules unknown"]).join(", ")}`,
        undefined,
        "Nothing was bound. A job with no proof does not settle; to end it with the mandate's refusal and take the net back, bind the refusal with --bind-refusal (or let `watch` do it once the rule is one the day cannot clear).",
      );
    } else {
      throw new SquareError(`No proof bound to job ${jobId}: ${outcome.detail}`);
    }
    return;
  }
  const events: DutyEvent[] = [];
  const duty = new ComplianceDuty({ client, policy, prover, onEvent: (e) => events.push(e), discover: false });
  duty.track(id, opts.category);
  const report = await duty.tick();
  if (opts.json) log.out(JSON.stringify({ report, events }, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof Error ? v.message : v), 2));
  else {
    log.blank();
    for (const event of events) log.raw(`  ${describeEvent(event, network)}`);
    if (report.waiting.length > 0) log.step(`Job ${jobId}: no release is possible yet, so nothing was bound; run this again as the window closes, or watch it.`);
    if (report.current.length > 0 && report.released.length === 0) log.success(`Job ${jobId}: the bound proof is current; the window has not closed.`);
    log.blank();
  }
  if (report.errors.length > 0) throw new SquareError(report.errors.map((e) => e.error.message).join("; "));
  if (report.refused.length > 0) throw new SquareError(report.refused.map((r) => r.reason).join("; "));
}

interface WatchOpts extends NetworkOpts {
  file: string;
  artifacts?: string;
  category: string;
  interval: number;
}

function watchCommand(): Command {
  return networkOptions(
    new Command("watch")
      .description("Keep these jobs' proofs current and release each when its window closes, until interrupted")
      .argument("<jobId...>", "Jobs this wallet is the client of")
      .requiredOption("--file <policy.json>", "The policy file")
      .option(ARTIFACTS_OPTION, ARTIFACTS_HELP)
      .requiredOption("--category <id>", "The capability the jobs bought")
      .option("--interval <seconds>", "How often to look; well inside the module's tolerance", (v) => Number(v), 15),
  ).action(async (jobIds: string[], opts: WatchOpts) => {
    for (const jobId of jobIds) if (!/^\d+$/.test(jobId)) throw new ValidationError(`${jobId} is not a job id`);
    const policy = readPolicy(opts.file);
    const prover = localProver(opts.artifacts);
    try {
      const { network, deployment } = await target(opts);
      const { client } = await signingSquare(network, deployment, `Watch ${jobIds.length} job(s)`);
      // The jobs named, and only those: the chain is not scanned for others (square#348 is the servers' recovery).
      const duty = new ComplianceDuty({ client, policy, prover, onEvent: (event) => log.raw(`  ${describeEvent(event, network)}`), discover: false });
      for (const jobId of jobIds) duty.track(BigInt(jobId), opts.category);
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort());
      process.once("SIGTERM", () => controller.abort());
      log.blank();
      log.step(`Watching ${jobIds.join(", ")} every ${opts.interval} s; Ctrl-C stops.`);
      await duty.run(controller.signal, { intervalMs: opts.interval * 1000 });
      log.blank();
    } finally {
      await prover.close();
    }
  });
}

function describeEvent(event: DutyEvent, network: Network): string {
  switch (event.type) {
    case "no-module":
      return `${c.dim("·")} the hook holds no compliance module; nothing to prove`;
    case "recovered":
      return `${c.dim("·")} recovered ${event.restored.length + event.discovered.length} job(s)`;
    case "bound":
      return `${c.green("✓")} job ${event.jobId}: proof bound in ${txLine(network, event.transaction)} (${event.because.join("; ")})`;
    case "refused":
      return `${c.red("✗")} job ${event.jobId}: no proof bound, ${event.reason}: ${event.detail}`;
    case "refusal-bound":
      return `${c.yellow("✗")} job ${event.jobId}: the policy's refusal bound in ${txLine(network, event.transaction)} (${(event.violated ?? ["rules unknown"]).join(", ")}); the release returns the net to this wallet`;
    case "released":
      return event.verified === false
        ? `${c.red("✗")} job ${event.jobId}: released in ${txLine(network, event.transaction)}, refused by the module (${event.refusedFor ?? "reason unknown"})`
        : event.payeeCleared === false
          ? `${c.red("✗")} job ${event.jobId}: released in ${txLine(network, event.transaction)}, refused by the screening: the payee ${event.payee} is not cleared, the net went back to the client`
          : `${c.green("✓")} job ${event.jobId}: released in ${txLine(network, event.transaction)}, ${formatUnits(event.amount, 6)} USDC to ${event.payee}`;
    case "held":
      // square#369: the window closed and the proof is current, but the hook would refuse the payee; nothing is sent until a screening lands.
      return `${c.yellow("…")} job ${event.jobId}: held, ${event.reason}`;
    case "settled":
      return `${c.dim("·")} job ${event.jobId}: settled by another hand (status ${event.status})`;
    case "error":
      return `${c.red("✗")} ${event.jobId === null ? "duty" : `job ${event.jobId}`}: ${event.error.message}`;
  }
}

// --------------------------------------------------------------- policy status

interface StatusOpts extends NetworkOpts {
  json?: boolean;
}

function statusCommand(): Command {
  return networkOptions(
    new Command("status")
      .description("Whether the proof bound to a job still describes the release the chain would make now")
      .argument("<jobId>", "The job")
      .option("--json", "Machine-readable result"),
  ).action(async (jobId: string, opts: StatusOpts) => {
    if (!/^\d+$/.test(jobId)) throw new ValidationError(`${jobId} is not a job id`);
    const { network, deployment } = await target(opts);
    const reader = readOnlySquare(network, deployment);
    const id = BigInt(jobId);
    const tolerance = await reader.complianceTolerance();
    const [bound, facts] = await Promise.all([reader.complianceProofOf(id), releaseFacts(reader, id)]);
    const state = tolerance === null ? null : proofState(bound, facts, tolerance / 2n);
    const decoded = decodeComplianceProof(bound);
    if (opts.json) {
      log.out(JSON.stringify({ jobId, module: tolerance !== null, toleranceSeconds: tolerance?.toString() ?? null, facts, state, signals: decoded ? signalsOf(decoded) : null }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
      return;
    }
    log.blank();
    log.field("job", `${jobId} on ${network.name}`);
    log.field("payee", facts.payee);
    log.field("net", `${formatUnits(facts.amount, 6)} USDC`);
    log.field("counter", `${formatUnits(facts.dailySpentBefore, 6)} USDC spent today by ${facts.client}`);
    log.field("policy", facts.pinnedCommitment === null ? `${facts.commitment} (the live commitment; nothing was pinned at funding)` : `${facts.pinnedCommitment} pinned at funding${facts.pinnedCommitment.toLowerCase() === facts.liveCommitment.toLowerCase() ? "" : `; the client has since committed ${facts.liveCommitment}, so this job is proved with the older file`}`);
    log.field("window", facts.challengeEnd === null ? "not submitted yet" : facts.challengeEnd <= facts.now ? `closed at ${facts.challengeEnd}` : `closes at ${facts.challengeEnd}, in ${facts.challengeEnd - facts.now}s`);
    if (tolerance === null) log.field("gate", "no module on the hook: the release is not proof gated");
    else if (state === null) log.field("proof", "unknown");
    else if (state.kind === "none") log.field("proof", "none bound: the release waits for one; nobody is paid or refunded until the client binds a proof");
    else if (state.kind === "malformed") log.field("proof", "malformed");
    else if (state.kind === "current") log.field("proof", `current, ${state.age}s old (tolerance ${tolerance}s)`);
    else log.field("proof", `stale: ${state.reasons.join("; ")}`);
    log.blank();
  });
}

export function policyCommand(): Command {
  const policy = new Command("policy").description("The institution's spending policy: write it, commit it, approve buyers, prove releases");
  policy.addCommand(initCommand());
  policy.addCommand(commitCommand());
  policy.addCommand(showCommand());
  policy.addCommand(buyersCommand());
  policy.addCommand(proveCommand());
  policy.addCommand(watchCommand());
  policy.addCommand(statusCommand());
  return policy;
}
