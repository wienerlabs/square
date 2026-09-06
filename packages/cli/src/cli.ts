import { Command } from "commander";
import { configCommand } from "./commands/config.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { registerCommand } from "./commands/register.js";
import { resolveCommand } from "./commands/resolve.js";
import { whoamiCommand } from "./commands/whoami.js";
import { ExitCode, isMandateError } from "./core/errors.js";
import { log } from "./core/logger.js";

export const VERSION = "0.1.0";

export function buildProgram(): Command {
  const program = new Command("mandate")
    .description("Agent identity on Arc: did:aip v2 over the ERC-8004 IdentityRegistry.")
    .version(VERSION)
    .showHelpAfterError();

  program.addCommand(loginCommand());
  program.addCommand(logoutCommand());
  program.addCommand(whoamiCommand());
  program.addCommand(registerCommand());
  program.addCommand(resolveCommand());
  program.addCommand(configCommand());

  return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  try {
    await buildProgram().parseAsync(argv);
  } catch (err) {
    if (isMandateError(err)) {
      log.blank();
      log.error(err.message, err.hint);
      log.blank();
      process.exitCode = err.exitCode;
      return;
    }
    // commander throws this for --help and --version, which are successes.
    if ((err as { code?: string }).code?.startsWith("commander.")) {
      process.exitCode = (err as { exitCode?: number }).exitCode ?? ExitCode.Ok;
      return;
    }
    log.blank();
    log.error(err instanceof Error ? err.message : String(err));
    log.blank();
    process.exitCode = ExitCode.Generic;
  }
}
