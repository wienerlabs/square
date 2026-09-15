// A request the caller got wrong is answered 400, and never reaches the prover.
//
// square#148 asked for the hour range to be a 400 rather than what it was. What
// it was depended on how wrong the hour happened to be: 24..31 was accepted by
// every layer and produced a window nothing satisfies, and 32 and above failed
// inside witness generation, so the caller received a constraint error from
// circom instead of the name of the field they got wrong. Both arrived as 500.
//
// This suite runs without the circuit artifacts, deliberately. Everything it
// asserts happens before proving starts, so a runner with no proving key still
// executes it — unlike prove-route.e2e.test.js, which skips itself. See
// docs/ci.md on suites that report green having run nothing.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';

const USDC = '0x3600000000000000000000000000000000000000';

const VALID = Object.freeze({
  policy_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
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

const window_ = (start, end) => ({
  timezone: 'UTC',
  allowed_days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  allowed_hours_start: start,
  allowed_hours_end: end,
});

describe('POST /prove refuses a bad request before proving', () => {
  let app;
  let request;
  let captured;
  const original = { log: console.log, error: console.error };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    ({ app } = await import('../src/index.js'));
    ({ default: request } = await import('supertest'));
  });

  function capture() {
    captured = [];
    console.log = (...args) => { captured.push(args.join(' ')); };
    console.error = (...args) => { captured.push(args.join(' ')); };
  }

  afterEach(() => {
    console.log = original.log;
    console.error = original.error;
  });

  const post = async (body) => {
    capture();
    const response = await request(app).post('/prove').send(body);
    console.log = original.log;
    console.error = original.error;
    return response;
  };

  it.each([24, 31, 32, 99999])('answers 400 for an hour of %i', async (hour) => {
    const response = await post({ ...VALID, time_restrictions: [window_(9, hour)] });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('allowed_hours_end');
    expect(response.body.error).toContain('0 to 23');
  });

  it('answers 400 for a window that crosses midnight, and says why', async () => {
    const response = await post({ ...VALID, time_restrictions: [window_(22, 6)] });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('not modelled');
    expect(response.body.error).toContain('allowed_hours_start');
  });

  // square#181. All three used to be accepted: the second record was validated
  // and dropped, its timezone never looked at, and an empty day list produced a
  // policy that forbade every weekday.
  it('answers 400 for a second time restriction', async () => {
    const response = await post({ ...VALID, time_restrictions: [window_(9, 17), window_(10, 12)] });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('only one window can be proved');
  });

  // square#226. The one spelling in this area that turned the rule off instead
  // of refusing: no 400, and a compliant proof with the window ignored.
  it('answers 400 for an empty time restriction list', async () => {
    const response = await post({ ...VALID, time_restrictions: [] });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('exactly one window');
  });

  it('answers 400 for an empty day list', async () => {
    const response = await post({
      ...VALID,
      time_restrictions: [{ ...window_(9, 17), allowed_days: [] }],
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('at least one day');
  });

  it('answers 400 for a timezone that is not UTC', async () => {
    const response = await post({
      ...VALID,
      time_restrictions: [{ ...window_(9, 17), timezone: 'America/New_York' }],
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('timezone');
  });

  // square#178: "0" reached the commitment and made all eight leaf salts
  // constants anybody can compute.
  it.each(['0', '1'])('answers 400 for a policy_salt of %s', async (salt) => {
    const response = await post({ ...VALID, policy_salt: salt });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('policy_salt');
    expect(response.body.error).toContain('2^128');
  });

  // normalize.js exists so a policy value never reaches a log line or a
  // response, and the secret of them all is no exception.
  it('never echoes the salt it refused', async () => {
    const weak = '1234567890123456789';
    const response = await post({ ...VALID, policy_salt: weak });
    expect(response.status).toBe(400);
    expect(response.body.error).not.toContain(weak);
  });

  it('answers 400 for a missing required field', async () => {
    const { policy_salt: _dropped, ...withoutSalt } = VALID;
    const response = await post(withoutSalt);
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('policy_salt');
  });

  // A refused policy is not a prover incident. Merging the two would put every
  // mistyped hour into the service's proof failure rate.
  it('logs a rejection as its own event, not as a failed proof', async () => {
    await post({ ...VALID, time_restrictions: [window_(22, 6)] });
    const logs = captured.join('\n');
    expect(logs).toContain('"event":"request_rejected"');
    expect(logs).not.toContain('"event":"proof_failed"');
    expect(logs).not.toContain('"event":"proof_generated"');
  });

  // normalize.js exists so that a policy value never reaches a log line or a
  // response body. The refusal path has to keep that promise too.
  it('never echoes the hour it refused, in the body or the log', async () => {
    const secret = 91735;
    await post({ ...VALID, time_restrictions: [window_(9, secret)] });
    const logs = captured.join('\n');
    expect(logs).not.toContain(String(secret));

    const response = await post({ ...VALID, time_restrictions: [window_(9, secret)] });
    expect(response.body.error).not.toContain(String(secret));
  });

  // square#251: the eleven requests the issue measured, each purely the caller's
  // mistake, each answered 500 and counted as a proof failure before the format
  // checks moved to the gate. Each message is the one the issue recorded.
  const MALFORMED = [
    ['an operator_id that is not an address', { operator_id: 'acme-corp' }, 'operator_id: must be a 20-byte hex address'],
    ['a payment_recipient with bad hex', { payment_recipient: '0x11111111111111111111111111111111111111zz' }, 'payment_recipient: must be a 20-byte hex address'],
    ['a policy_id that is not a UUID', { policy_id: 'not-a-uuid' }, 'policy_id: not a valid UUID'],
    ['an unknown weekday name', { time_restrictions: [{ ...window_(9, 17), allowed_days: ['mondayy'] }] }, 'time_restrictions.allowed_days: contains an unknown weekday name'],
    ['a fractional payment_amount', { payment_amount: 5000000.5 }, 'payment_amount: must be a whole number'],
    ['a negative payment_amount', { payment_amount: '-5000000' }, 'payment_amount: must be a non-negative integer'],
    ['a max_daily_spend that is not a number', { max_daily_spend: 'a lot' }, 'max_daily_spend: must be a non-negative integer'],
    ['an empty category string', { payment_endpoint_category: '' }, 'payment_endpoint_category: must not be empty'],
    ['a category over 32 bytes', { allowed_endpoint_categories: ['x'.repeat(33)] }, 'allowed_endpoint_categories: exceeds the 32-byte limit'],
    ['a blocked_addresses entry that is an object', { blocked_addresses: [{ address: '0x2222222222222222222222222222222222222222' }] }, 'blocked_addresses: must be a string'],
    ['a stripe_receipt_hash that is not a number', { stripe_receipt_hash: 'garbage' }, 'stripe_receipt_hash: must be a non-negative integer'],
    // square#253: well formed, and still no proof can come out of it.
    ['a payment_token that is the zero address', { payment_token: `0x${'0'.repeat(40)}` }, 'payment_token: must not be the zero address; the circuit rejects a zero lookup key'],
    ['a payment_recipient that is the zero address', { payment_recipient: `0x${'0'.repeat(40)}` }, 'payment_recipient: must not be the zero address; the circuit rejects a zero lookup key'],
  ];

  const failures = async () => {
    const response = await request(app).get('/metrics');
    const match = /square_proof_failures_total\{[^}]*\} (\d+)/.exec(response.text);
    return match ? Number(match[1]) : 0;
  };

  it.each(MALFORMED)('answers 400 for %s, naming the field', async (_, overrides, message) => {
    const response = await post({ ...VALID, ...overrides });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe(message);
    const logs = captured.join('\n');
    expect(logs).toContain('"event":"request_rejected"');
    expect(logs).not.toContain('"event":"proof_failed"');
  });

  it('counts none of the thirteen as a proof failure', async () => {
    const before = await failures();
    for (const [, overrides] of MALFORMED) {
      expect((await post({ ...VALID, ...overrides })).status).toBe(400);
    }
    expect(await failures()).toBe(before);
  });

  // Two mistakes of one kind in one object used to answer two codes: the hour
  // was checked at the gate and the day name after it.
  it('answers an hour of 25 and a day of "mondayy" with the same code', async () => {
    const hour = await post({ ...VALID, time_restrictions: [window_(9, 25)] });
    const day = await post({ ...VALID, time_restrictions: [{ ...window_(9, 17), allowed_days: ['mondayy'] }] });
    expect(hour.status).toBe(400);
    expect(day.status).toBe(hour.status);
  });

  it('still takes a window that does not wrap', async () => {
    // Asserted as "not 400" rather than "200" because what happens next depends
    // on the runner: with the artifacts present this proves and returns 200,
    // without them proving fails and returns 500. Either way the gate let it
    // through, which is the whole claim.
    const response = await post({ ...VALID, time_restrictions: [window_(9, 18)] });
    expect(response.status).not.toBe(400);
  });
});
