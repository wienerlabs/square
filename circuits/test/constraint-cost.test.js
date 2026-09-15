// The circuit's size, as the repository quotes it, against what circom compiled.
//
// square#238. circuits/README.md's constraint table was two circuit changes
// old: it said 2609 non-linear and "smaller than what it replaced" while the
// compiler said 4849, and the ptau record, fetch-ptau.mjs and a test comment
// each quoted a third figure. Nothing compared any of them with a build. The
// arithmetic of the table is checked here without one; the figures themselves
// are checked against build/*.r1cs whenever the circuits are compiled, which the
// circuits job does before its tests.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD, isCompiled, r1csConstraintCounts } from './helpers/signals.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPO = path.resolve(ROOT, '..');
const read = (...parts) => fs.readFileSync(path.join(REPO, ...parts), 'utf8');

const HAVE_BUILD = ['payment', 'timestamp_checked', 'timestamp_unchecked'].every((circuit) => isCompiled(circuit));

const README = read('circuits', 'README.md');
const SECTION = README.slice(README.indexOf('## Constraint cost, measured'), README.indexOf('## Building and testing'));

// "**+1986**", "−28", "11584" as numbers; the table uses a real minus sign.
const figure = (cell) => Number(cell.replace(/[*,\s]/g, '').replace('−', '-').replace(/^\+/, ''));

function row(label) {
  const line = SECTION.split('\n').find((l) => l.startsWith(`| ${label} |`));
  if (!line) throw new Error(`no row "${label}" in circuits/README.md's constraint table`);
  return line.split('|').slice(2, -1).map((cell) => figure(cell));
}

// A number the prose quotes, by the words around it.
function quoted(text, pattern, where) {
  const match = pattern.exec(text);
  if (!match) throw new Error(`${where}: nothing matches ${pattern}`);
  return Number(match[1].replaceAll(',', ''));
}

const APERTURE = row("Aperture's original `payment.circom`");
const THIS = row('This `payment.circom`');
const CHANGE = row('Change');
const ATTRIBUTION = ['Rule 6 constrained properly', '`Num2Bits(64)` on the two amounts']
  .concat(SECTION.split('\n').filter((l) => /^\| .*(#119|#45|lookup keys|Mask arrays|Addresses collapsed)/.test(l)).map((l) => l.split('|')[1].trim()));
const NET = row('net')[0];

describe("circuits/README.md's constraint table adds up", () => {
  it("has a change row that is this circuit minus Aperture's, column by column", () => {
    expect(CHANGE).toEqual(THIS.map((value, i) => value - APERTURE[i]));
  });

  it('has an attribution that sums to its net, and a net that is the change in non-linear constraints', () => {
    const sum = ATTRIBUTION.reduce((total, label) => total + row(label)[0], 0);
    expect(ATTRIBUTION).toHaveLength(7);
    expect(sum).toBe(NET);
    expect(NET).toBe(CHANGE[0]);
  });

  it("measures #45's and #119's rows by the variants it names", () => {
    const without45 = quoted(SECTION, /without #45's leaves it is (\d+) non-linear/, 'README');
    const without119 = quoted(SECTION, /without #119's ceiling bounds (\d+)/, 'README');
    const withoutBoth = quoted(SECTION, /without both (\d+)/, 'README');
    const leaves = row('Salted leaves, eight `Poseidon(3)` under the root ([#45](https://github.com/wienerlabs/square/issues/45))')[0];
    const ceilings = row('`Num2Bits(64)` on the two ceilings ([#119](https://github.com/wienerlabs/square/issues/119))')[0];
    expect(THIS[0] - without45).toBe(leaves);
    expect(THIS[0] - without119).toBe(ceilings);
    expect(without45 - withoutBoth).toBe(ceilings);
  });
});

describe.skipIf(!HAVE_BUILD)('what the compiler says', () => {
  const payment = HAVE_BUILD ? r1csConstraintCounts(path.join(BUILD, 'payment.r1cs')) : null;

  it("is the table's row for this circuit", () => {
    expect(THIS).toEqual([payment.nonLinear, payment.linear, payment.wires]);
  });

  it('is the soundness figure, the two timestamp templates compiled standalone', () => {
    const checked = r1csConstraintCounts(path.join(BUILD, 'timestamp_checked.r1cs'));
    const unchecked = r1csConstraintCounts(path.join(BUILD, 'timestamp_unchecked.r1cs'));
    expect(quoted(SECTION, /`timestamp_checked` is (\d+) non-linear/, 'README')).toBe(checked.nonLinear);
    expect(quoted(SECTION, /against `timestamp_unchecked`'s (\d+)/, 'README')).toBe(unchecked.nonLinear);
    expect(checked.nonLinear - unchecked.nonLinear).toBe(row('Rule 6 constrained properly')[0]);
  });

  // Every other place that states this circuit's size today.
  it.each([
    ['docs/ceremony/phase1-ptau.md', ['docs', 'ceremony', 'phase1-ptau.md'], /compiles to ([\d,]+) constraints/, 'constraints'],
    ['docs/ceremony/phase1-ptau.md, the refusal', ['docs', 'ceremony', 'phase1-ptau.md'], /(\d+)\*2 > 2\*\*13/, 'constraints'],
    ['docs/ceremony/phase1-ptau.md, the total', ['docs', 'ceremony', 'phase1-ptau.md'], /\*\*total\*\*, which went from [\d,]+ to ([\d,]+)/, 'constraints'],
    ['docs/ceremony/phase1-ptau.md, the non-linear count', ['docs', 'ceremony', 'phase1-ptau.md'], /took those from\s+[\d,]+ to ([\d,]+)/, 'nonLinear'],
    ['circuits/scripts/fetch-ptau.mjs', ['circuits', 'scripts', 'fetch-ptau.mjs'], /not the non-linear count: ([\d,]+)/, 'constraints'],
    ['circuits/scripts/fetch-ptau.mjs, the refusal', ['circuits', 'scripts', 'fetch-ptau.mjs'], /(\d+)\*2 > 2\*\*13/, 'constraints'],
    ['circuits/test/ptau-adoption.test.js, the non-linear count', ['circuits', 'test', 'ptau-adoption.test.js'], /constraints from [\d,]+ to ([\d,]+)/, 'nonLinear'],
    ['circuits/test/ptau-adoption.test.js, the total', ['circuits', 'test', 'ptau-adoption.test.js'], /total went from [\d,]+ to ([\d,]+)/, 'constraints'],
    ['circuits/test/helpers/signals.mjs', ['circuits', 'test', 'helpers', 'signals.mjs'], /nine wires — ([\d,]+) of them/, 'wires'],
    ['circuits/test/payment.test.js', ['circuits', 'test', 'payment.test.js'], /it has ([\d,]+)/, 'wires'],
    ['docs/deploy/end-to-end-5042002.md, the proof', ['docs', 'deploy', 'end-to-end-5042002.md'], /over ([\d,]+) witness variables/, 'wires'],
    ['docs/deploy/end-to-end-5042002.md, the growth', ['docs', 'deploy', 'end-to-end-5042002.md'], /witness variables to ([\d,]+)/, 'wires'],
  ])('is what %s quotes', (where, parts, pattern, measure) => {
    expect(quoted(read(...parts), pattern, where)).toBe(payment[measure]);
  });
});

describe.skipIf(HAVE_BUILD)('what the compiler says', () => {
  it('skipped: run `npm run build -- --no-zkey` first', () => {
    expect(HAVE_BUILD).toBe(false);
  });
});
