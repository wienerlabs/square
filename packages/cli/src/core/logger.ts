import { c, glyph } from "./theme.js";

/**
 * Human output goes to stderr, machine output to stdout.
 *
 * `square resolve --json | jq` has to work, and it only works if progress
 * chatter never lands in the same stream as the document.
 */
export const log = {
  /** The result. stdout. */
  out(line = ""): void {
    process.stdout.write(`${line}\n`);
  },
  /** Commentary. stderr. */
  raw(line = ""): void {
    process.stderr.write(`${line}\n`);
  },
  blank(): void {
    process.stderr.write("\n");
  },
  step(msg: string): void {
    process.stderr.write(`  ${c.dim(glyph.arrow)} ${msg}\n`);
  },
  success(msg: string): void {
    process.stderr.write(`  ${c.green(glyph.ok)} ${msg}\n`);
  },
  warn(msg: string): void {
    process.stderr.write(`  ${c.yellow(glyph.warn)} ${msg}\n`);
  },
  error(msg: string, hint?: string): void {
    process.stderr.write(`  ${c.red(glyph.fail)} ${c.red(msg)}\n`);
    if (hint) process.stderr.write(`    ${c.dim(hint)}\n`);
  },
  field(label: string, value: string): void {
    process.stderr.write(`    ${c.label(label)} ${value}\n`);
  },
};
