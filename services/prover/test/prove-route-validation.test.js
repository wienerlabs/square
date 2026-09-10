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

  it('still takes a window that does not wrap', async () => {
    // Asserted as "not 400" rather than "200" because what happens next depends
    // on the runner: with the artifacts present this proves and returns 200,
    // without them proving fails and returns 500. Either way the gate let it
    // through, which is the whole claim.
    const response = await post({ ...VALID, time_restrictions: [window_(9, 18)] });
    expect(response.status).not.toBe(400);
  });
});
