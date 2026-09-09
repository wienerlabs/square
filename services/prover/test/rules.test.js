// The off-circuit rule evaluator.
//
// The circuit exposes `is_compliant` and nothing else, so this module exists to
// answer "which rule failed" — the part the violation log is allowed to say out
// loud. It is only worth anything if it agrees with the circuit, and a
// confident wrong rule name is worse than none.
//
// Two layers cover that. Here, the predicates are exercised directly against
// witnesses built by the real request path, with no circuit needed, so they run
// everywhere. circuit-agreement.test.js then holds the same inputs against the
// compiled circuit, which is where a disagreement would actually surface.

import { describe, it, expect } from 'vitest';
import { evaluateRules, RULES } from '../src/rules.js';
import { buildCircuitInput } from '../src/prover.js';

const ADDR = {
  usdc: '0x3600000000000000000000000000000000000000',
  other: '0x00000000000000000000000000000000000000ff',
  provider: '0x1111111111111111111111111111111111111111',
  blocked: '0x2222222222222222222222222222222222222222',
  operator: '0x3333333333333333333333333333333333333333',
};

// 2026-09-02T13:45:30Z — a Wednesday at 13:45 UTC. Mon=0, so weekday 2.
const TIMESTAMP = '1788356730';
const WEDNESDAY = ['wednesday'];
const THURSDAY = ['thursday'];

function request(overrides = {}) {
  return {
    policy_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    // square#45: the secret the eight leaf salts derive from.
    policy_salt: '7777777777777777777777777777777777777777777777777777777777777',
    operator_id: ADDR.operator,
    max_daily_spend: '100000000',
    max_per_transaction: '10000000',
    allowed_endpoint_categories: ['api-call'],
    blocked_addresses: [ADDR.blocked],
    token_whitelist: [ADDR.usdc],
    payment_amount: '5000000',
    payment_token: ADDR.usdc,
    payment_recipient: ADDR.provider,
    payment_endpoint_category: 'api-call',
    daily_spent_before: '50000000',
    current_unix_timestamp: TIMESTAMP,
    ...overrides,
  };
}

const evaluate = async (overrides) => evaluateRules(await buildCircuitInput(request(overrides)));

const window = (days, start, end) => ({
  time_restrictions: [{
    allowed_days: days, allowed_hours_start: start,
    allowed_hours_end: end, timezone: 'UTC',
  }],
});

describe('a compliant payment', () => {
  it('violates nothing', async () => {
    const { compliant, violated } = await evaluate({});
    expect(compliant).toBe(true);
    expect(violated).toEqual([]);
  });
});

describe('rule 1, the per-transaction ceiling', () => {
  it('flags an amount over the ceiling', async () => {
    const { violated } = await evaluate({ payment_amount: '10000001', daily_spent_before: '0' });
    expect(violated).toEqual([RULES.PER_TRANSACTION_LIMIT]);
  });

  it('allows an amount exactly on the ceiling', async () => {
    const { compliant } = await evaluate({ payment_amount: '10000000', daily_spent_before: '0' });
    expect(compliant).toBe(true);
  });
});

describe('rule 2, the daily ceiling', () => {
  it('flags a payment that would cross it', async () => {
    const { violated } = await evaluate({ daily_spent_before: '95000001' });
    expect(violated).toEqual([RULES.DAILY_LIMIT]);
  });

  it('allows a payment that lands exactly on it', async () => {
    const { compliant } = await evaluate({ daily_spent_before: '95000000' });
    expect(compliant).toBe(true);
  });
});

describe('rule 3, the token whitelist', () => {
  it('flags a token that is not on the list', async () => {
    const { violated } = await evaluate({ payment_token: ADDR.other });
    expect(violated).toEqual([RULES.TOKEN_WHITELIST]);
  });

  it('accepts any entry on the list, not only the first', async () => {
    const { compliant } = await evaluate({
      token_whitelist: [ADDR.other, ADDR.usdc], payment_token: ADDR.usdc,
    });
    expect(compliant).toBe(true);
  });

  it('does not match a padding slot', async () => {
    // Padding is zero and there are no masks any more; the guard is that a
    // lookup key can never be zero. Reaching here with one is a bug, and the
    // evaluator refuses rather than reporting a membership the circuit would
    // not stand behind.
    const input = await buildCircuitInput(request());
    await expect(evaluateRules({ ...input, token_in: '0' })).rejects.toThrow(/zero/);
  });
});

describe('rule 4, the blocked list', () => {
  it('flags a blocked recipient', async () => {
    const { violated } = await evaluate({ payment_recipient: ADDR.blocked });
    expect(violated).toEqual([RULES.BLOCKED_RECIPIENT]);
  });

  it('passes when the blocked list is empty', async () => {
    const { compliant } = await evaluate({ blocked_addresses: [] });
    expect(compliant).toBe(true);
  });
});

describe('rule 5, the endpoint category', () => {
  it('flags a category that is not allowed', async () => {
    const { violated } = await evaluate({ payment_endpoint_category: 'exfiltration' });
    expect(violated).toEqual([RULES.ENDPOINT_CATEGORY]);
  });
});

describe('rule 6, the time window', () => {
  it('is a free pass when no window is configured', async () => {
    const { compliant } = await evaluate({});
    expect(compliant).toBe(true);
  });

  it('passes inside the window', async () => {
    const { compliant } = await evaluate(window(WEDNESDAY, 9, 17));
    expect(compliant).toBe(true);
  });

  it('flags a day the policy does not allow', async () => {
    const { violated } = await evaluate(window(THURSDAY, 0, 23));
    expect(violated).toEqual([RULES.TIME_WINDOW]);
  });

  it('flags an hour before the window opens', async () => {
    const { violated } = await evaluate(window(WEDNESDAY, 14, 17));
    expect(violated).toEqual([RULES.TIME_WINDOW]);
  });

  it('flags an hour after the window closes', async () => {
    const { violated } = await evaluate(window(WEDNESDAY, 9, 12));
    expect(violated).toEqual([RULES.TIME_WINDOW]);
  });

  it('accepts the boundary hours', async () => {
    for (const [start, end] of [[13, 13], [13, 23], [0, 13]]) {
      const { compliant } = await evaluate(window(WEDNESDAY, start, end));
      expect(compliant, `window ${start}..${end}`).toBe(true);
    }
  });
});

describe('several rules at once', () => {
  it('reports every one that failed, not just the first', async () => {
    const { violated } = await evaluate({
      payment_amount: '999999999',
      payment_token: ADDR.other,
      payment_recipient: ADDR.blocked,
    });
    expect(violated).toContain(RULES.PER_TRANSACTION_LIMIT);
    expect(violated).toContain(RULES.DAILY_LIMIT);
    expect(violated).toContain(RULES.TOKEN_WHITELIST);
    expect(violated).toContain(RULES.BLOCKED_RECIPIENT);
  });
});
