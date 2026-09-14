// What POST /prove says when it is already full, and while it is.
//
// square#236: nothing bounded the proofs in flight, so a batch, a retry storm or
// an unauthenticated client put all of them into snarkjs at once — and each one
// re-reads the proving key. The ceiling itself is asserted in
// concurrency.test.js; this file is about what the route does with it.
//
// The proof is stubbed here, deliberately. An earlier draft of this file ran
// only against real artifacts and skipped otherwise, which meant the hermetic
// CI job — the one that runs on every push — verified none of it. The draft
// said mocking had been tried and did not work; the review of #236 showed the
// mock factory was simply wrong, missing the `importOriginal` spread, so the
// route went on importing the real module. It works, and the counter below
// proves it on every run: `proofs.entered` would stay at zero otherwise.
//
// What is stubbed is only how long a proof takes and what it returns. The route,
// the limiter, validateRequest, the logging and the metrics are all the real
// ones. The real proof is still exercised, at the same three properties, in
// prove-backpressure.e2e.test.js when the artifacts are there.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';

// Shared with the mock factory, which is hoisted above the imports.
const proofs = vi.hoisted(() => ({
  entered: 0,
  active: 0,
  peak: 0,
  delayMs: 60,
  fail: null,
  notify: null,
  reset(delayMs = 60) {
    this.entered = 0; this.active = 0; this.peak = 0;
    this.delayMs = delayMs; this.fail = null; this.notify = null;
  },
}));

vi.mock('../src/prover.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // Everything the route reads back is here; nothing else about a proof
    // matters to back-pressure. `rules_agree` and `is_compliant` are both true,
    // so logging.js writes the success line and nothing that could carry a
    // request value.
    generateProof: async () => {
      proofs.entered += 1;
      proofs.active += 1;
      proofs.peak = Math.max(proofs.peak, proofs.active);
      proofs.notify?.();
      try {
        await new Promise((done) => setTimeout(done, proofs.delayMs));
        if (proofs.fail) throw new Error(proofs.fail);
        return {
          is_compliant: true,
          rules_agree: true,
          violated_rules: [],
          operator_id: '0x3333333333333333333333333333333333333333',
          policy_data_hash: '1',
          policy_data_hash_hex: '0x01',
          public_signals: {},
          solidity: {},
          raw_proof: {},
          raw_public: [],
          verification_timestamp: 1788356730,
        };
      } finally {
        proofs.active -= 1;
      }
    },
  };
});

const REQUEST = Object.freeze({
  policy_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  policy_salt: '7777777777777777777777777777777777777777777777777777777777777',
  operator_id: '0x3333333333333333333333333333333333333333',
  max_daily_spend: '100000000',
  max_per_transaction: '10000000',
  allowed_endpoint_categories: ['api-call'],
  blocked_addresses: ['0x2222222222222222222222222222222222222222'],
  token_whitelist: ['0x3600000000000000000000000000000000000000'],
  payment_token: '0x3600000000000000000000000000000000000000',
  payment_recipient: '0x1111111111111111111111111111111111111111',
  payment_amount: '5000000',
  daily_spent_before: '50000000',
  payment_endpoint_category: 'api-call',
  current_unix_timestamp: '1788356730',
});

// The limiter reads its bounds when the route module is imported, so a suite
// that wants different bounds has to load a fresh copy of the module graph.
async function serviceWith({ concurrency, queue, timeoutMs }) {
  process.env.PROVER_MAX_CONCURRENCY = String(concurrency);
  process.env.PROVER_MAX_QUEUE = String(queue);
  process.env.PROVER_PROOF_TIMEOUT_MS = String(timeoutMs);
  vi.resetModules();
  return (await import('../src/index.js')).app;
}

// Resolves once `n` proofs have actually entered generateProof. Waiting on this
// rather than on a timer is the point: a bare supertest request sends nothing
// until it is awaited, so a test that slept and then probed /health was
// measuring an idle service. This cannot pass without work in flight.
const untilEntered = (n) => new Promise((resolve) => {
  const check = () => { if (proofs.entered >= n) resolve(); };
  proofs.notify = check;
  check();
});

describe('a service that is already full', () => {
  let app;
  beforeAll(async () => {
    app = await serviceWith({ concurrency: 1, queue: 1, timeoutMs: 60_000 });
  });

  const post = () => request(app).post('/prove').send(REQUEST);

  it('sheds with 503 and Retry-After rather than queueing without bound', async () => {
    proofs.reset(80);
    // One proves, one waits, the other three are refused.
    const responses = await Promise.all([post(), post(), post(), post(), post()]);

    expect(responses.filter((r) => r.status === 200)).toHaveLength(2);
    const shed = responses.filter((r) => r.status === 503);
    expect(shed).toHaveLength(3);
    for (const response of shed) {
      expect(response.headers['retry-after']).toBe('1');
      expect(response.body).toEqual({ error: 'busy', retryAfterSeconds: 1 });
    }
    // The stub was reached, so the mock is in the route's graph and the rest of
    // this file is measuring something.
    expect(proofs.entered).toBe(2);
  });

  it('takes the next request once the ceiling clears', async () => {
    proofs.reset(20);
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.body.is_compliant).toBe(true);
    expect(response.body.proving_time_ms).toBeGreaterThanOrEqual(0);
  });
});

describe('while the ceiling is full', () => {
  let app;
  beforeAll(async () => {
    app = await serviceWith({ concurrency: 2, queue: 8, timeoutMs: 60_000 });
  });

  it('answers /health and /metrics with proofs actually in flight', async () => {
    proofs.reset(400);
    // `.then()` dispatches; a supertest request that is only constructed sends
    // nothing at all.
    const inFlight = [0, 1, 2, 3].map(() => request(app).post('/prove').send(REQUEST).then((r) => r.status));

    await untilEntered(2);
    expect(proofs.active).toBe(2);

    const health = await request(app).get('/health');
    const metrics = await request(app).get('/metrics');

    // Still busy when the probes came back — otherwise this proves nothing.
    expect(proofs.active).toBeGreaterThan(0);
    // 503 when the artifacts are absent, which is the hermetic job's case: the
    // check is that it answers, and answers as itself.
    expect([200, 503]).toContain(health.status);
    expect(health.body.service).toBe('square-prover');
    expect(metrics.status).toBe(200);
    expect(metrics.text).toContain('square_proof_duration_seconds');

    // Saturation is readable from outside, which is the point: an operator
    // watching this service should not have to infer how full it is from the
    // rate of 503s. Two of two slots taken, with the ceiling published beside
    // them so the ratio can be written without hardcoding the configuration.
    expect(metrics.text).toMatch(/square_proof_slots_active\{[^}]*\}\s+2/);
    expect(metrics.text).toMatch(/square_proof_slots_limit\{[^}]*\}\s+2/);
    expect(metrics.text).toMatch(/square_proof_slots_queued\{[^}]*\}\s+2/);

    expect(await Promise.all(inFlight)).toEqual([200, 200, 200, 200]);
    // And the ceiling held while all four went through.
    expect(proofs.peak).toBe(2);
  });
});

describe('a proof that outruns its bound', () => {
  let app;
  beforeAll(async () => {
    app = await serviceWith({ concurrency: 2, queue: 64, timeoutMs: 40 });
  });

  it('is answered 504, and the ceiling still bounds the work behind it', async () => {
    // Every proof outruns the deadline. The caller is answered at 40 ms, but the
    // work is still running and still holding the memory the ceiling exists to
    // bound, so no more than two may be inside generateProof at any moment.
    // Measured in the review of #236 as 8 against a ceiling of 4 before the fix.
    proofs.reset(300);
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => request(app).post('/prove').send(REQUEST)),
    );

    expect(responses.every((r) => r.status === 504)).toBe(true);
    expect(String(responses[0].body.error)).toContain('timed out');
    expect(proofs.peak).toBe(2);

    // Two proofs were started and ten were not: the rest were still queued when
    // their own deadline passed, and the bound runs from when a request arrives
    // rather than from when it reaches the front. Before that, a caller with a
    // 5 000 ms bound behind a full queue waited 5 147 ms and was never shed.
    expect(proofs.entered).toBe(2);
  }, 30_000);
});

describe('a proof that fails for a reason of its own', () => {
  let app;
  beforeAll(async () => {
    app = await serviceWith({ concurrency: 2, queue: 8, timeoutMs: 60_000 });
  });

  it('is a 500 even when the failure says "timed out"', async () => {
    // An unreadable proving key reports `ETIMEDOUT`. Reading the deadline off
    // the words in a message answered that 504, which tells the caller to retry
    // something no retry will fix. The limiter's own deadline is a type now.
    proofs.reset(10);
    proofs.fail = 'ETIMEDOUT: reading the proving key timed out';

    const response = await request(app).post('/prove').send(REQUEST);
    expect(response.status).toBe(500);
  });
});
