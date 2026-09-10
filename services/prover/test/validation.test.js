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
  // square#45: the secret the eight leaf salts derive from.
  policy_salt: '7777777777777777777777777777777777777777777777777777777777777',
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

// Which error a caller hears when more than one thing is wrong.
//
// square#45 made policy_salt required, and every test above became a test of
// that too — because validateRequest reports missing fields before it checks
// the shape of the ones that are present, so an incomplete fixture makes every
// format assertion unreachable. That is how these tests broke: not because the
// behaviour they cover changed, but because a field was added to the request.
//
// The ordering is deliberate and is not changed here: a field that is absent
// cannot be format-checked, and the missing-field pass reports all of them at
// once where the format checks stop at the first. What was missing is any
// statement of it. These three assert the priority directly, so the next
// required field breaks this describe — which says what happened — instead of
// a dozen assertions elsewhere that say something else.
describe('which error wins when two things are wrong', () => {
  const withoutSalt = () => {
    const req = { ...BASE };
    delete req.policy_salt;
    return req;
  };

  it('reports a malformed field when nothing is missing', async () => {
    await expect(buildCircuitInput({ ...BASE, time_restrictions: {} }))
      .rejects.toThrow('time_restrictions: must be an array');
  });

  it('reports a missing field when nothing is malformed', async () => {
    await expect(buildCircuitInput(withoutSalt()))
      .rejects.toThrow('Missing required field(s): policy_salt');
  });

  it('reports the missing field when both are wrong', async () => {
    await expect(buildCircuitInput({ ...withoutSalt(), time_restrictions: {} }))
      .rejects.toThrow('Missing required field(s): policy_salt');
  });

  it('names every missing field at once, not one per round trip', async () => {
    const req = { ...BASE };
    delete req.policy_salt;
    delete req.max_daily_spend;
    await expect(buildCircuitInput(req))
      .rejects.toThrow(/Missing required field\(s\): .*max_daily_spend.*policy_salt|.*policy_salt.*max_daily_spend/);
  });
});

// square#148. The window's hours had three upper bounds and none of them was
// enforced: openapi.js declared 0..23, the circuit's Num2Bits(5) allowed 0..31,
// and toFieldString allowed everything under the BN254 modulus. And nothing
// anywhere refused start > end, which is a window no hour satisfies.
describe('the window hours are bounded, and the window has a direction', () => {
  it.each([
    ['midnight to midnight', 0, 0],
    ['a single hour', 12, 12],
    ['the whole day', 0, 23],
    ['a working day', 9, 17],
  ])('accepts %s', async (_name, start, end) => {
    const input = await build({
      time_restrictions: [{ ...WINDOW, allowed_hours_start: start, allowed_hours_end: end }],
    });
    expect(input.time_start_hour_utc).toBe(String(start));
    expect(input.time_end_hour_utc).toBe(String(end));
  });

  // 24..31 is the gap between the schema and the circuit. Both sides accepted
  // it and neither is an hour: an end of 31 behaves like 23, and a start of 25
  // empties the window so every payment under the policy is refused.
  it.each([24, 25, 31])('rejects %i, which the circuit would have accepted', async (hour) => {
    await expect(build({ time_restrictions: [{ ...WINDOW, allowed_hours_start: hour }] }))
      .rejects.toThrow('time_restrictions.allowed_hours_start: must be an hour of the day, 0 to 23');
    await expect(build({ time_restrictions: [{ ...WINDOW, allowed_hours_end: hour }] }))
      .rejects.toThrow('time_restrictions.allowed_hours_end: must be an hour of the day, 0 to 23');
  });

  // 32 and above used to fail inside witness generation, where the caller got a
  // constraint error rather than the name of the field they got wrong.
  it.each([32, 99999, '1788356730'])('rejects %s by field name, not in the witness', async (hour) => {
    await expect(build({ time_restrictions: [{ ...WINDOW, allowed_hours_end: hour }] }))
      .rejects.toThrow('time_restrictions.allowed_hours_end: must be an hour of the day, 0 to 23');
  });

  it('still rejects a non-integer hour by field name', async () => {
    await expect(build({ time_restrictions: [{ ...WINDOW, allowed_hours_start: 9.5 }] }))
      .rejects.toThrow('time_restrictions.allowed_hours_start: must be a whole number');
    await expect(build({ time_restrictions: [{ ...WINDOW, allowed_hours_start: -1 }] }))
      .rejects.toThrow(/allowed_hours_start/);
  });

  // The finding. 22:00 to 06:00 is an ordinary thing to want for an agent that
  // works overnight; the circuit computes `hour >= start AND hour <= end`, so
  // under it no hour of any day is inside the window and every payment the
  // policy covers is refused with the same 'time_window' a genuine miss gets.
  it.each([
    ['an overnight window', 22, 6],
    ['one hour backwards', 10, 9],
    ['the widest wrap', 23, 0],
  ])('rejects %s rather than accepting one nothing satisfies', async (_name, start, end) => {
    await expect(build({
      time_restrictions: [{ ...WINDOW, allowed_hours_start: start, allowed_hours_end: end }],
    })).rejects.toThrow(/allowed_hours_start must not be later than allowed_hours_end/);
  });

  it('says why, so the caller learns the night window is not modelled', async () => {
    await expect(build({
      time_restrictions: [{ ...WINDOW, allowed_hours_start: 22, allowed_hours_end: 6 }],
    })).rejects.toThrow(/window that crosses midnight is not modelled/);
  });

  // normalize.js exists so a policy value never reaches a log line or a response.
  it('never echoes the hour it refused', async () => {
    const secret = 99999;
    await expect(build({ time_restrictions: [{ ...WINDOW, allowed_hours_end: secret }] }))
      .rejects.toThrow(expect.not.stringContaining(String(secret)));
  });
});

// square#181. Three ways a policy reached the circuit as something other than
// what was sent, all measured by running buildCircuitInput rather than reading it.
describe('one window, and it has to be a window somebody could satisfy', () => {
  // The finding. validateRequest checked every entry field by field, which says
  // plural is supported; buildCircuitInput reads `[0]` and nothing else.
  it('refuses a second entry rather than validating it and dropping it', async () => {
    const second = { ...WINDOW, allowed_days: ['saturday'], allowed_hours_start: 10, allowed_hours_end: 12 };
    await expect(build({ time_restrictions: [WINDOW, second] }))
      .rejects.toThrow(/2 entries were given and only one window can be proved/);
  });

  it('says why, so the caller learns the commitment holds one window', async () => {
    await expect(build({ time_restrictions: [WINDOW, WINDOW] }))
      .rejects.toThrow(/commitment covers a single window/);
  });

  it('still takes exactly one', async () => {
    const input = await build({ time_restrictions: [WINDOW] });
    expect(input.time_active).toBe('1');
    expect(input.time_start_hour_utc).toBe('9');
  });

  // The timezone used to be checked on `[0]` only, and after validation. A
  // second record could carry a zone that is refused when sent on its own.
  it('refuses a timezone it does not support, in the only record there is', async () => {
    await expect(build({ time_restrictions: [{ ...WINDOW, timezone: 'America/New_York' }] }))
      .rejects.toThrow("time_restrictions.timezone: only 'UTC' is supported");
  });

  // The finding itself: on main this request was accepted and the second
  // record's America/New_York never looked at, even though the same value sent
  // on its own is refused. It cannot slip through now, because a second record
  // does not get that far.
  it('no longer lets a second record carry a timezone nobody checks', async () => {
    const newYork = { ...WINDOW, timezone: 'America/New_York' };
    await expect(build({ time_restrictions: [WINDOW, newYork] })).rejects.toThrow(
      /only one window can be proved/,
    );
  });

  it('leaves the timezone optional, as it was', async () => {
    const { timezone: _dropped, ...withoutZone } = WINDOW;
    const input = await build({ time_restrictions: [withoutZone] });
    expect(input.time_active).toBe('1');
  });

  // An empty day list forbids every weekday: the same class of value as the
  // `??` defaults this file already refuses, and it was the one getting through.
  it('refuses an empty day list rather than forbidding every weekday', async () => {
    await expect(build({ time_restrictions: [{ ...WINDOW, allowed_days: [] }] }))
      .rejects.toThrow(/must name at least one day/);
  });

  it('says how to express no window at all', async () => {
    await expect(build({ time_restrictions: [{ ...WINDOW, allowed_days: [] }] }))
      .rejects.toThrow(/omit time_restrictions entirely/);
  });

  it('and one day is enough', async () => {
    const input = await build({ time_restrictions: [{ ...WINDOW, allowed_days: ['wednesday'] }] });
    expect(input.time_days_bitmask).toBe('4');
  });
});
