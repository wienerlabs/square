import { Command } from "commander";
import { readFile } from "node:fs/promises";
import * as p from "@clack/prompts";
import { MandateError, ValidationError } from "../core/errors.js";
import { log } from "../core/logger.js";
import { c } from "../core/theme.js";
import {
  encryptKeystore,
  generateWallet,
  importPrivateKey,
  keystoreExists,
  saveKeystore,
  type Wallet,
} from "../core/wallet.js";
import { paths } from "../core/paths.js";

interface LoginOpts {
  importKey?: string;
  importFile?: string;
  force?: boolean;
}

export function loginCommand(): Command {
  return new Command("login")
    .description("Create or import a secp256k1 wallet and store it encrypted")
    .option("--import-key <hex>", "Import a private key (64 hex chars, 0x optional)")
    .option("--import-file <path>", "Import a private key from a file containing that hex")
    .option("--force", "Replace an existing keystore")
    .addHelpText(
      "after",
      `
Examples:
  $ mandate login
  $ mandate login --import-file ./key.hex --force

The key is encrypted with scrypt (N=2^17) and AES-256-GCM, and written to
${paths.keystoreFile()} with mode 0600. Losing the passphrase loses the key:
there is no recovery path and no copy anywhere else.
`,
    )
    .action(async (opts: LoginOpts) => {
      await runLogin(opts);
    });
}

async function runLogin(opts: LoginOpts): Promise<void> {
  if (opts.importKey && opts.importFile) {
    throw new ValidationError("Use --import-key or --import-file, not both");
  }
  if ((await keystoreExists()) && !opts.force) {
    throw new ValidationError(
      `A keystore already exists at ${paths.keystoreFile()}`,
      "Back it up, then pass --force to replace it. Replacing it is irreversible.",
    );
  }
  if (!process.stderr.isTTY) {
    throw new MandateError(
      "Cannot prompt for a passphrase outside an interactive terminal",
      undefined,
      "Run 'mandate login' from a TTY. For unattended signing, set MANDATE_PRIVATE_KEY instead.",
    );
  }

  let wallet: Wallet;
  let imported = false;
  if (opts.importKey) {
    wallet = importPrivateKey(opts.importKey);
    imported = true;
  } else if (opts.importFile) {
    let raw: string;
    try {
      raw = await readFile(opts.importFile, "utf8");
    } catch (err) {
      throw new ValidationError(`Could not read ${opts.importFile}: ${(err as Error).message}`);
    }
    wallet = importPrivateKey(raw);
    imported = true;
  } else {
    wallet = generateWallet();
  }

  const passphrase = await p.password({
    message: "Choose a passphrase (at least 8 characters)",
    mask: "*",
    validate: (v) => (v && v.length >= 8 ? undefined : "At least 8 characters."),
  });
  if (p.isCancel(passphrase)) {
    p.cancel("Cancelled. Nothing was written.");
    throw new MandateError("Login cancelled");
  }
  const confirm = await p.password({ message: "Repeat it", mask: "*" });
  if (p.isCancel(confirm)) {
    p.cancel("Cancelled. Nothing was written.");
    throw new MandateError("Login cancelled");
  }
  if (String(passphrase) !== String(confirm)) {
    throw new ValidationError("The two passphrases do not match");
  }

  log.step("Deriving the encryption key (scrypt N=2^17 — this takes a moment)…");
  const keystore = await encryptKeystore(wallet, String(passphrase));
  await saveKeystore(keystore);

  log.blank();
  log.success(imported ? "Wallet imported" : "Wallet created");
  log.field("address", c.cyan(wallet.address));
  log.field("keystore", paths.keystoreFile());
  log.blank();
  if (!imported) {
    log.warn("This key exists only in that file. Back it up, and remember the passphrase.");
    log.blank();
  }
  log.raw(`  Next: ${c.cyan("mandate whoami")} to see the balance, then ${c.cyan("mandate register")}.`);
  log.blank();
}
