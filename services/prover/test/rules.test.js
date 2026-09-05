// The off-circuit rule evaluator has to agree with the circuit, or the rule
// names it feeds into the violation log are worse than useless.
//
// The fixtures under test/fixtures/ are the circuit's own test inputs, carried
// over from aperture. circuit-ground-truth.json is not hand-written: it is the
// witness output of the compiled payment.circom for those same fixtures, so
// these assertions compare this module against the circuit itself rather than
// against someone's expectation of it. Regenerate it with
// test/tools/regenerate-ground-truth.mjs when the circuit changes.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateRules, RULES } from '../src/rules.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

function loadFixture(name) {
  const input = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
  // The committed fixtures predate the Stripe receipt signal. Zero is the
  // documented "no Stripe involved" value and is what the ground-truth run used.
  if (input.stripe_receipt_hash_in === undefined) input.stripe_receipt_hash_in = '0';
  return input;
}

const groundTruth = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'circuit-ground-truth.json'), 'utf8'),
);

describe('evaluateRules agrees with the compiled circuit', () => {
  for (const [fixture, outputs] of Object.entries(groundTruth)) {
    it(`${fixture} → is_compliant=${outputs.is_compliant}`, async () => {
      const { compliant } = await evaluateRules(loadFixture(fixture));
      expect(compliant).toBe(outputs.is_compliant === '1');
    });
  }
});

describe('the ground truth matches what aperture recorded', () => {
  // ok_compliant.expected.json is the upstream fixture's own record of the
  // circuit's public outputs. Checking the regenerated ground truth against it
  // catches a mis-set OUTPUT_ORDER or a witness read at the wrong offset, which
  // would otherwise make every assertion in this file agree with itself and
  // with nothing else.
  it('agrees on every signal the upstream fixture records', () => {
    const expected = JSON.parse(
      fs.readFileSync(path.join(FIXTURES, 'ok_compliant.expected.json'), 'utf8'),
    );
    const actual = groundTruth['ok_compliant.json'];
    for (const [signal, value] of Object.entries(expected)) {
      expect(actual[signal], signal).toBe(value);
    }
  });
});

describe('evaluateRules names the rule that failed', () => {
  it('flags nothing for the compliant fixture', async () => {
    const { compliant, violated } = await evaluateRules(loadFixture('ok_compliant.json'));
    expect(compliant).toBe(true);
    expect(violated).toEqual([]);
  });

  it('flags the per-transaction limit', async () => {
    const { violated } = await evaluateRules(loadFixture('bad_amount_exceeds_per_tx.json'));
    expect(violated).toContain(RULES.PER_TRANSACTION_LIMIT);
  });

  it('flags a blocked recipient', async () => {
    const { violated } = await evaluateRules(loadFixture('bad_recipient_blocked.json'));
    expect(violated).toEqual([RULES.BLOCKED_RECIPIENT]);
  });

  it('flags a mint that is not whitelisted', async () => {
    const { violated } = await evaluateRules(loadFixture('bad_token_not_whitelisted.json'));
    expect(violated).toEqual([RULES.TOKEN_WHITELIST]);
  });
});

describe('evaluateRules covers the rules the fixtures do not', () => {
  // The circuit fixtures exercise three of the six rules. These build on the
  // compliant fixture so every other field stays a value the circuit accepted.
  it('flags the daily limit when the projected total exceeds the ceiling', async () => {
    const input = loadFixture('ok_compliant.json');
    input.daily_spent_before_in = String(
      BigInt(input.max_daily_lamports) - BigInt(input.amount_lamports_in) + 1n,
    );
    const { compliant, violated } = await evaluateRules(input);
    expect(compliant).toBe(false);
    expect(violated).toEqual([RULES.DAILY_LIMIT]);
  });

  it('allows a payment that lands exactly on the daily ceiling', async () => {
    const input = loadFixture('ok_compliant.json');
    input.daily_spent_before_in = String(
      BigInt(input.max_daily_lamports) - BigInt(input.amount_lamports_in),
    );
    const { compliant } = await evaluateRules(input);
    expect(compliant).toBe(true);
  });

  it('allows a payment that lands exactly on the per-transaction ceiling', async () => {
    const input = loadFixture('ok_compliant.json');
    input.amount_lamports_in = input.max_per_tx_lamports;
    input.daily_spent_before_in = '0';
    const { compliant } = await evaluateRules(input);
    expect(compliant).toBe(true);
  });

  it('flags a category that is not on the allowed list', async () => {
    const input = loadFixture('ok_compliant.json');
    input.payment_category = '12345';
    const { violated } = await evaluateRules(input);
    expect(violated).toEqual([RULES.ENDPOINT_CATEGORY]);
  });

  it('ignores padding slots when checking membership', async () => {
    // Slot 0 is active, the rest are zero-valued padding with mask 0. A
    // zero-valued category must not match a padding slot.
    const input = loadFixture('ok_compliant.json');
    input.payment_category = '0';
    const { violated } = await evaluateRules(input);
    expect(violated).toEqual([RULES.ENDPOINT_CATEGORY]);
  });

  it('reports every rule that failed, not just the first', async () => {
    const input = loadFixture('bad_amount_exceeds_per_tx.json');
    input.payment_category = '12345';
    const { violated } = await evaluateRules(input);
    expect(violated).toContain(RULES.PER_TRANSACTION_LIMIT);
    expect(violated).toContain(RULES.ENDPOINT_CATEGORY);
  });
});

describe('time window rule', () => {
  // 2025-01-01T00:00:00Z, the timestamp the fixtures use, was a Wednesday.
  // Mon=0 in the bitmask, so Wednesday is bit 2.
  const WEDNESDAY_BIT = 1 << 2;
  const THURSDAY_BIT = 1 << 3;

  it('is a free pass when no window is configured', async () => {
    const { compliant } = await evaluateRules(loadFixture('ok_compliant.json'));
    expect(compliant).toBe(true);
  });

  it('passes inside the window', async () => {
    const input = loadFixture('ok_compliant.json');
    input.time_active = '1';
    input.time_days_bitmask = String(WEDNESDAY_BIT);
    input.time_start_hour_utc = '0';
    input.time_end_hour_utc = '23';
    const { compliant } = await evaluateRules(input);
    expect(compliant).toBe(true);
  });

  it('fails on a day the policy does not allow', async () => {
    const input = loadFixture('ok_compliant.json');
    input.time_active = '1';
    input.time_days_bitmask = String(THURSDAY_BIT);
    input.time_start_hour_utc = '0';
    input.time_end_hour_utc = '23';
    const { violated } = await evaluateRules(input);
    expect(violated).toEqual([RULES.TIME_WINDOW]);
  });

  it('fails outside the hour range', async () => {
    const input = loadFixture('ok_compliant.json');
    input.time_active = '1';
    input.time_days_bitmask = String(WEDNESDAY_BIT);
    input.time_start_hour_utc = '9';
    input.time_end_hour_utc = '17';
    const { violated } = await evaluateRules(input);
    expect(violated).toEqual([RULES.TIME_WINDOW]);
  });
});
