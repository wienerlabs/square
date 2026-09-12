// What POST /prove says when it is already full, and while it is.
//
// square#236: nothing bounded the proofs in flight, so a batch, a retry storm or
// an unauthenticated client put all of them into snarkjs at once — and each one
// re-reads the proving key. Measured with a stub in the issue: 250 concurrent
// requests, a peak of 243 simultaneous proofs, no back-pressure at all. The
// ceiling itself is asserted in concurrency.test.js, at that scale; this file is
// about what the route does with it.
//
// Real proofs, no stubs. An earlier draft mocked `generateProof`, and the route
// went on calling the real one while the mock's counter stayed at zero — the
// tests passed nothing and would have been evidence of nothing. A proof takes
// about 1.2 s here, which is slow for a unit test and exactly right for this
// one: it is the duration the ceiling and the timeout are measured against.
// Without the artifacts there is nothing to bound, so the suite skips.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = process.env.PROVER_ARTIFACTS_DIR
  ? path.resolve(process.env.PROVER_ARTIFACTS_DIR)
  : path.resolve(HERE, '..', 'artifacts');

const hasArtifacts =
  fs.existsSync(path.join(ARTIFACTS, 'payment.wasm')) &&
  fs.existsSync(path.join(ARTIFACTS, 'payment.zkey'));

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

describe.skipIf(!hasArtifacts)('a service that is already full', () => {
  let app;

  beforeAll(async () => {
    // Read when the route module is imported, so they are set first. One at a
    // time, one waiting, and a bound far longer than the ~1.2 s a proof takes
    // so nothing here times out by accident.
    process.env.PROVER_MAX_CONCURRENCY = '1';
    process.env.PROVER_MAX_QUEUE = '1';
    process.env.PROVER_PROOF_TIMEOUT_MS = '60000';
    ({ app } = await import('../src/index.js'));
  }, 120_000);

  const post = () => request(app).post('/prove').send(REQUEST);

  it('sheds with 503 and Retry-After rather than queueing without bound', async () => {
    // One proves, one waits, the other three are refused.
    const responses = await Promise.all([post(), post(), post(), post(), post()]);
    const proved = responses.filter((r) => r.status === 200);
    const shed = responses.filter((r) => r.status === 503);

    expect(proved).toHaveLength(2);
    expect(shed).toHaveLength(3);
    for (const response of shed) {
      expect(response.headers['retry-after']).toBe('1');
      expect(response.body.error).toBe('busy');
      expect(response.body.retryAfterSeconds).toBe(1);
    }
  }, 120_000);

  it('answers /health and /metrics while the ceiling is full', async () => {
    const inFlight = [post(), post()];

    // Long enough that the first proof is under way, short enough that it has
    // not finished: the window the container's health probe lives in.
    await new Promise((done) => setTimeout(done, 150));
    const health = await request(app).get('/health');
    const metrics = await request(app).get('/metrics');

    expect([200, 503]).toContain(health.status);
    expect(health.body.service).toBe('square-prover');
    expect(metrics.status).toBe(200);
    expect(metrics.text).toContain('square_proof_duration_seconds');

    await Promise.all(inFlight);
  }, 120_000);

  it('takes the next request once the ceiling clears', async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.body.is_compliant).toBe(true);
  }, 120_000);
});

// A separate module registry, because the bound is read at import time and this
// one has to be shorter than a proof.
describe.skipIf(!hasArtifacts)('a proof that outruns its bound', () => {
  let app;

  beforeAll(async () => {
    process.env.PROVER_MAX_CONCURRENCY = '1';
    process.env.PROVER_MAX_QUEUE = '1';
    process.env.PROVER_PROOF_TIMEOUT_MS = '50';
    // Without this the import above returns the instance the first block
    // already built, bound at 60 s, and the timeout below would never fire.
    vi.resetModules();
    ({ app } = await import('../src/index.js'));
  }, 120_000);

  it('is answered 504, and the slot goes back', async () => {
    const timedOut = await request(app).post('/prove').send(REQUEST);
    expect(timedOut.status).toBe(504);
    expect(String(timedOut.body.error)).toContain('timed out');

    // The slot is free immediately rather than held by work nobody is waiting
    // for: a second request is admitted and answered the same way, which it
    // could not be if the first were still counted as running.
    const next = await request(app).post('/prove').send(REQUEST);
    expect(next.status).toBe(504);
  }, 120_000);
});

describe.skipIf(hasArtifacts)('back-pressure on POST /prove', () => {
  it('skipped: no circuit artifacts present', () => {
    expect(hasArtifacts).toBe(false);
  });
});
