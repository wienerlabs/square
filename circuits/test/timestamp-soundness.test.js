// The forged-weekday attack, and the constraint that stops it.
//
// The time-window rule used to enforce nothing. Its timestamp decomposition
// witnessed `day_index` and `weeks` and checked only the division identities
// and the remainders, leaving both quotients unbounded. Since 7 is invertible
// modulo the BN254 scalar field, a prover writing a witness by hand could pick
// any weekday d and solve `weeks = (day_index + 3 - d) / 7` in the field. The
// identity still holds, `d < 7` still holds, and the rule waves through a
// payment made on a day the policy forbids.
//
// These tests run that attack against both templates: the one that shipped
// (test/circuits/timestamp_unchecked.circom) and the fixed one payment.circom
// uses (lib/timestamp.circom). The control matters — a test that only shows the
// fixed circuit rejecting something proves nothing about what it is rejecting.

import { describe, it, expect } from 'vitest';
import { calculateWitness, isBuilt } from './helpers/witness.mjs';

// BN254 scalar field modulus.
const R = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617',
);

function modInverse(a, m) {
  let [oldR, r] = [((a % m) + m) % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return ((oldS % m) + m) % m;
}

const HAVE_BUILD = isBuilt('timestamp_checked') && isBuilt('timestamp_unchecked');

// 2026-09-02T13:45:30Z — a Wednesday.
const TIMESTAMP = 1788356730n;

function honestDecomposition(ts) {
  const dayIndex = ts / 86400n;
  const secInDay = ts % 86400n;
  return {
    timestamp: ts.toString(),
    day_index: dayIndex.toString(),
    sec_in_day: secInDay.toString(),
    hour: (secInDay / 3600n).toString(),
    sec_in_hour: (secInDay % 3600n).toString(),
    weeks: ((dayIndex + 3n) / 7n).toString(),
    day_of_week: ((dayIndex + 3n) % 7n).toString(),
  };
}

// The attack: keep the timestamp and every honest field, but claim a different
// weekday and solve for the `weeks` that makes the identity hold in the field.
function forgeWeekday(ts, targetDayOfWeek) {
  const honest = honestDecomposition(ts);
  const dayIndex = BigInt(honest.day_index);
  const target = BigInt(targetDayOfWeek);
  const forgedWeeks = ((dayIndex + 3n - target) * modInverse(7n, R)) % R;
  return { ...honest, weeks: forgedWeeks.toString(), day_of_week: target.toString() };
}

describe.skipIf(!HAVE_BUILD)('timestamp decomposition', () => {
  const checked = (input) => calculateWitness('timestamp_checked', input);
  const unchecked = (input) => calculateWitness('timestamp_unchecked', input);

  it('the honest decomposition satisfies both templates', async () => {
    const input = honestDecomposition(TIMESTAMP);
    // 2026-09-02 is a Wednesday: Mon=0, so 2.
    expect(input.day_of_week).toBe('2');
    expect(input.hour).toBe('13');

    await expect(checked(input)).resolves.toBeDefined();
    await expect(unchecked(input)).resolves.toBeDefined();
  });

  it('the identity a forged weekday relies on really does hold', () => {
    // Not a circuit assertion — this is the arithmetic the attack rests on, so
    // it is worth stating outright: the forged triple satisfies
    // weeks * 7 + day_of_week == day_index + 3 in the field.
    const forged = forgeWeekday(TIMESTAMP, 5);
    const lhs = (BigInt(forged.weeks) * 7n + BigInt(forged.day_of_week)) % R;
    const rhs = (BigInt(forged.day_index) + 3n) % R;
    expect(lhs).toBe(rhs);
    expect(forged.day_of_week).toBe('5');
    expect(forged.day_of_week).not.toBe(honestDecomposition(TIMESTAMP).day_of_week);
  });

  it('the shipped template ACCEPTS a forged weekday — this is the bug', async () => {
    const forged = forgeWeekday(TIMESTAMP, 5);
    const witness = await unchecked(forged);
    // Output signals come first in the witness, after the constant 1:
    // hour_out then day_of_week_out.
    expect(witness[2]).toBe('5');
  });

  it('the fixed template REJECTS a forged weekday', async () => {
    const forged = forgeWeekday(TIMESTAMP, 5);
    await expect(checked(forged)).rejects.toThrow();
  });

  it('rejects a forged weekday for every day of the week', async () => {
    const honest = Number(honestDecomposition(TIMESTAMP).day_of_week);
    for (let d = 0; d < 7; d += 1) {
      if (d === honest) continue;
      const forged = forgeWeekday(TIMESTAMP, d);
      await expect(checked(forged), `weekday ${d} should be rejected`)
        .rejects.toThrow();
    }
  });

  it('rejects an out-of-range day_index even when the identities are patched up', async () => {
    // The other half of the same hole: an unbounded day_index lets a prover
    // move the whole clock. sec_in_day is solved so the day identity still
    // holds, and weeks/day_of_week are solved for the shifted index.
    const honest = honestDecomposition(TIMESTAMP);
    const hugeDayIndex = (R - 1n) / 2n;
    const secInDay = (((BigInt(honest.timestamp) - hugeDayIndex * 86400n) % R) + R) % R;
    const forged = {
      ...honest,
      day_index: hugeDayIndex.toString(),
      sec_in_day: secInDay.toString(),
      weeks: (((hugeDayIndex + 3n - 2n) * modInverse(7n, R)) % R).toString(),
    };
    await expect(checked(forged)).rejects.toThrow();
  });

  it('rejects an hour outside 0..23', async () => {
    const honest = honestDecomposition(TIMESTAMP);
    const forged = { ...honest, hour: '25', sec_in_hour: '0' };
    await expect(checked(forged)).rejects.toThrow();
  });

  it('rejects a timestamp wider than the declared bound', async () => {
    // UtcDayHourChecked(40) reaches the year 36812. Anything past that must
    // fail rather than wrap.
    const tooBig = 1n << 41n;
    const input = honestDecomposition(tooBig);
    await expect(checked(input)).rejects.toThrow();
  });

  it('agrees with the platform clock across a year of samples', async () => {
    // The decomposition has to be right, not just unforgeable.
    for (let i = 0; i < 40; i += 1) {
      const ts = 1767225600n + BigInt(i) * 9_123_457n; // from 2026-01-01, irregular steps
      const input = honestDecomposition(ts);
      const date = new Date(Number(ts) * 1000);
      const jsWeekday = (date.getUTCDay() + 6) % 7; // JS Sun=0 -> Mon=0
      expect(input.day_of_week, `weekday for ${date.toISOString()}`)
        .toBe(String(jsWeekday));
      expect(input.hour, `hour for ${date.toISOString()}`)
        .toBe(String(date.getUTCHours()));
      await expect(checked(input)).resolves.toBeDefined();
    }
  });
});

describe.skipIf(HAVE_BUILD)('timestamp decomposition', () => {
  it('skipped: run `npm run build` first', () => {
    expect(HAVE_BUILD).toBe(false);
  });
});
