// Input that reaches the witness generator without being checked.
//
// square#119. Three findings, one class: /prove is stateless and takes the whole
// policy in the request body, so `validateRequest` is the only thing between a
// caller and the circuit. It type-checked three of the four list fields and
// nothing else.
//
// The quiet one is the time window. A `time_restrictions` value that is not an
// array was discarded, `time_active` became 0, and rule 6 in the circuit is
// `1 - time_active + time_active * compliant` — exactly 1 when `time_active` is
// 0. The window stopped being enforced, and nothing in the response said so,
// because the off-circuit evaluator short-circuits on the same field: `rules_agree`
// stayed true and `violated_rules` stayed empty.

import { describe, it, expect } from 'vitest';
import { buildCircuitInput } from '../src/prover.js';
import { padCategoryList } from '../src/hash.js';

const USDC = '0x3600000000000000000000000000000000000000';

const BASE = Object.freeze({
  policy_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  operator_id: '0x3333333333333333333333333333333333333333',
  max_daily_spend: '100000000',
  max_per_transaction: '10000000',
  allowed_endpoint_categories: ['api-call'],
  blocked_addresses: ['0x2222222222222222222222222222222222222222'],
  token_whitelist: [USDC],
  payment_token: USDC,
  payment_recipient: '0x1111111111111111111111111111111111111111',
  payment_amount: '5000000',
  daily_spent_before: '50000000',
  payment_endpoint_category: 'api-call',
  current_unix_timestamp: '1788356730',
});

const WINDOW = Object.freeze({
  timezone: 'UTC',
  allowed_days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  allowed_hours_start: 9,
  allowed_hours_end: 18,
});

const build = (overrides) => buildCircuitInput({ ...BASE, ...overrides });

describe('time_restrictions, the field that used to fail open', () => {
  it('is accepted as an array, and turns the rule on', async () => {
    const input = await build({ time_restrictions: [WINDOW] });
    expect(input.time_active).toBe('1');
    expect(input.time_start_hour_utc).toBe('9');
    expect(input.time_end_hour_utc).toBe('18');
  });

  it('is still optional, and its absence still means no window', async () => {
    const input = await build({});
    expect(input.time_active).toBe('0');
  });

  // The finding. `{...}` instead of `[{...}]` was silently discarded, and the
  // caller got a compliant proof with the window switched off.
  it('rejects a bare object instead of quietly switching the rule off', async () => {
    await expect(build({ time_restrictions: WINDOW }))
      .rejects.toThrow('time_restrictions: must be an array');
  });

  it.each([
    ['a string', 'weekdays 9-18'],
    ['a number', 1],
    ['a boolean', true],
  ])('rejects %s', async (_name, value) => {
    await expect(build({ time_restrictions: value }))
      .rejects.toThrow('time_restrictions: must be an array');
  });

  it('rejects an array of non-objects', async () => {
    await expect(build({ time_restrictions: ['monday'] }))
      .rejects.toThrow('time_restrictions: each entry must be an object');
    await expect(build({ time_restrictions: [[WINDOW]] }))
      .rejects.toThrow('time_restrictions: each entry must be an object');
  });
});

// Every one of these used to fall back to a value nobody would mean by accident:
// no days is every weekday forbidden, and no hours is a window of 00:00 to 00:59.
describe('a restriction has no defaults', () => {
  it.each(['allowed_days', 'allowed_hours_start', 'allowed_hours_end'])(
    'requires %s',
    async (field) => {
      const partial = { ...WINDOW };
      delete partial[field];
      await expect(build({ time_restrictions: [partial] }))
        .rejects.toThrow(`time_restrictions.${field}: required when a restriction is given`);
    },
  );

  it('requires allowed_days to be an array', async () => {
    await expect(build({ time_restrictions: [{ ...WINDOW, allowed_days: 'monday' }] }))
      .rejects.toThrow('time_restrictions.allowed_days: must be an array');
  });

  it('still throws on an unknown weekday, as it always did', async () => {
    await expect(build({ time_restrictions: [{ ...WINDOW, allowed_days: ['funday'] }] }))
      .rejects.toThrow(/unknown weekday name/);
  });
});

describe('list lengths are checked before anything hashes them', () => {
  it.each([
    ['allowed_endpoint_categories', 8],
    ['blocked_addresses', 10],
    ['token_whitelist', 10],
  ])('%s is capped at %i', async (field, max) => {
    const one = BASE[field][0];
    await expect(build({ [field]: Array.from({ length: max + 1 }, () => one) }))
      .rejects.toThrow(`${field}: exceeds the circuit maximum of ${max} entries`);
  });

  it('accepts exactly the maximum', async () => {
    const input = await build({
      allowed_endpoint_categories: Array.from({ length: 8 }, (_, i) => `category-${i}`),
    });
    expect(input.allowed_categories).toHaveLength(8);
  });

  // The ordering, which is the finding rather than the cap.
  //
  // padCategoryList used to hash every entry and only then discover the list was
  // too long. Poseidon runs about 100 microseconds per entry and `await` on an
  // already-resolved value never yields, so 20,000 categories meant roughly two
  // seconds with the event loop blocked and the work discarded. The threshold is
  // twenty times the budget this should need, so it fails on a regression rather
  // than on a slow machine.
  it('rejects an oversized category list without hashing any of it', async () => {
    const huge = Array.from({ length: 20_000 }, (_, i) => `category-${i}`);
    const started = process.hrtime.bigint();
    await expect(build({ allowed_endpoint_categories: huge }))
      .rejects.toThrow('allowed_endpoint_categories: exceeds the circuit maximum of 8 entries');
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(ms).toBeLessThan(100);
  });

  // The cap is part of the policy, so the message says the ceiling and not how
  // many were sent — list cardinality is what the circuit exists to hide.
  it('does not say how many entries were sent', async () => {
    const huge = Array.from({ length: 4_242 }, () => 'api-call');
    await expect(build({ allowed_endpoint_categories: huge })).rejects.toThrow(
      /^allowed_endpoint_categories: exceeds the circuit maximum of 8 entries$/,
    );
  });
});

// padCategoryList is guarded independently of validateRequest.
//
// The two checks are not redundant: validateRequest is the HTTP boundary, and
// padCategoryList is what any future caller reaches directly. Testing only
// through buildCircuitInput would leave the second one covered by accident, and
// it is the one the finding was actually about.
describe('padCategoryList guards itself', () => {
  it('refuses an oversized list', async () => {
    await expect(padCategoryList(['a', 'b'], 1, 'categories'))
      .rejects.toThrow('categories: exceeds the circuit maximum of 1 entries');
  });

  it('refuses it without hashing, which is the whole point', async () => {
    const huge = Array.from({ length: 20_000 }, (_, i) => `category-${i}`);
    const started = process.hrtime.bigint();
    await expect(padCategoryList(huge, 8, 'allowed_endpoint_categories')).rejects.toThrow();
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(ms).toBeLessThan(100);
  });

  it('still hashes a list that fits', async () => {
    const out = await padCategoryList(['api-call', 'inference'], 8, 'categories');
    expect(out).toHaveLength(8);
    expect(out[0]).not.toBe('0');
    expect(out[2]).toBe('0');
  });
});
