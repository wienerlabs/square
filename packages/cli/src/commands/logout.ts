import { Command } from "commander";
import * as p from "@clack/prompts";
import { SquareError } from "../core/errors.js";
import { log } from "../core/logger.js";
import { paths } from "../core/paths.js";
import { deleteKeystore, keystoreExists } from "../core/wallet.js";
import { lockWallet } from "../core/unlock.js";

export function logoutCommand(): Command {
  return new Command("logout")
    .description("Delete the local keystore")
    .option("-y, --yes", "Skip the confirmation")
    .option("--json", "Machine-readable result")
    .action(async (opts: { yes?: boolean; json?: boolean }) => {
      const report = (deleted: boolean): void => {
        if (opts.json) log.out(JSON.stringify({ deleted, keystore: paths.keystoreFile() }, null, 2));
      };
      // keystoreExists throws for a keystore that is there but cannot be
      // looked at, rather than answering "nothing to delete".
      if (!(await keystoreExists())) {
        log.step("No keystore to delete.");
        report(false);
        return;
      }
      if (!opts.yes) {
        if (!process.stderr.isTTY) {
          throw new SquareError(
            "Confirmation required",
            undefined,
            "Re-run with --yes from a non-interactive context.",
          );
        }
        const ok = await p.confirm({
          message: `Delete ${paths.keystoreFile()}? The key is not recoverable without your backup.`,
          initialValue: false,
        });
        if (p.isCancel(ok) || ok === false) {
          p.cancel("Cancelled. The keystore is untouched.");
          report(false);
          return;
        }
      }
      // deleteKeystore names a keystore it found but could not remove.
      await deleteKeystore();
      lockWallet();
      log.success("Keystore deleted.");
      report(true);
    });
}
