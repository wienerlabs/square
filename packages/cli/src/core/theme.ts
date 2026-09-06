/**
 * Colour without a dependency.
 *
 * A CLI that pipes into `jq` or a CI log must not emit escape codes, so colour
 * is decided once, here, from NO_COLOR and whether stderr is a terminal. It is
 * stderr rather than stdout because every coloured string this module produces
 * is written to stderr; see logger.ts for why the two streams are split.
 */

/** Built from the code point so no literal control byte appears in the source. */
const CSI = `${String.fromCharCode(27)}[`;

export const colorEnabled =
  !process.env.NO_COLOR &&
  process.env.TERM !== "dumb" &&
  process.stderr.isTTY === true;

function wrap(open: number, close: number): (s: string) => string {
  return (s) => (colorEnabled ? `${CSI}${open}m${s}${CSI}${close}m` : s);
}

const dim = wrap(2, 22);

export const c = {
  bold: wrap(1, 22),
  dim,
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
  /**
   * Left column of a key/value line. Padded before colouring, so the escape
   * codes do not count towards the width.
   */
  label: (s: string): string => dim(s.padEnd(14)),
};

export const glyph = {
  ok: "✓",
  fail: "✗",
  warn: "!",
  arrow: "→",
};
