import { Command } from "commander";
import { readFile } from "node:fs/promises";
import * as p from "@clack/prompts";
import { SquareError, ValidationError } from "../core/errors.js";
import { log } from "../core/logger.js";
import { c } from "../core/theme.js";
import {
  assertKeystoreReplaceable,
  encryptKeystore,
  generateWallet,
  importPrivateKey,
  keystoreExists,
  saveKeystore,
  type Wallet,
} from "../core/wallet.js";
import { paths } from "../core/paths.js";

interface LoginOpts {
  importFile?: string;
  force?: boolean;
  json?: boolean;
}

export function loginCommand(): Command {
  return new Command("login")
    .description("Create or import a secp256k1 wallet and store it encrypted")
    .option("--import-file <path>", "Import a private key from a file holding its hex")
    .option("--force", "Replace an existing keystore")
    .option("--json", "Machine-readable result")
    .addHelpText(
      "after",
      `
Examples:
  $ square login
  $ square login --import-file ./key.hex --force
  $ square login --import-file <(some-vault export-key)

The key is encrypted with scrypt (N=2^17) and AES-256-GCM, and written to
${paths.keystoreFile()} with mode 0600. Losing the passphrase loses the key:
there is no recovery path and no copy anywhere else.

There is no --import-key <hex>. A key on the command line is a key in the
process table and in the shell history, the same exposure SQUARE_PRIVATE_KEY
warns about; a file leaves neither, and the shell's <(...) makes one out of a
command without touching the disk. stdin is not an option either: the
passphrase prompt reads from it.
`,
    )
    .action(async (opts: LoginOpts) => {
      await runLogin(opts);
    });
}

async function runLogin(opts: LoginOpts): Promise<void> {
  if (await keystoreExists()) {
    if (!opts.force) {
      throw new ValidationError(
        `A keystore already exists at ${paths.keystoreFile()}`,
        "Back it up, then pass --force to replace it. Replacing it is irreversible.",
      );
    }
    // --force replaces by rename, which needs the directory and not the file,
    // so a keystore nobody can read would be replaced unseen. Not this one.
    await assertKeystoreReplaceable();
  }
  if (!process.stderr.isTTY) {
    throw new SquareError(
      "Cannot prompt for a passphrase outside an interactive terminal",
      undefined,
      "Run 'square login' from a TTY. For unattended signing, set SQUARE_PRIVATE_KEY instead.",
    );
  }

  let wallet: Wallet;
  let imported = false;
  if (opts.importFile) {
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
    throw new SquareError("Login cancelled");
  }
  const confirm = await p.password({ message: "Repeat it", mask: "*" });
  if (p.isCancel(confirm)) {
    p.cancel("Cancelled. Nothing was written.");
    throw new SquareError("Login cancelled");
  }
  if (String(passphrase) !== String(confirm)) {
    throw new ValidationError("The two passphrases do not match");
  }

  log.step("Deriving the encryption key (scrypt N=2^17 — this takes a moment)…");
  const keystore = await encryptKeystore(wallet, String(passphrase));
  await saveKeystore(keystore);

  if (opts.json) {
    log.out(JSON.stringify({ address: wallet.address, keystore: paths.keystoreFile(), imported }, null, 2));
  }

  log.blank();
  log.success(imported ? "Wallet imported" : "Wallet created");
  log.field("address", c.cyan(wallet.address));
  log.field("keystore", paths.keystoreFile());
  log.blank();
  if (!imported) {
    log.warn("This key exists only in that file. Back it up, and remember the passphrase.");
    log.blank();
  }
  log.raw(`  Next: ${c.cyan("square whoami")} to see the balance, then ${c.cyan("square register")}.`);
  log.blank();
}
