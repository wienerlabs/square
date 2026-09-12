// The same three properties as prove-backpressure.test.js, against real proofs.
//
// That file stubs how long a proof takes so the hermetic CI job can verify the
// route on every push. This one stubs nothing: a genuine Groth16 prove, roughly
// 700 ms here, which is the duration the ceiling and the deadline are actually
// measured against. It skips when the artifacts are absent rather than passing
// on nothing.

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

async function serviceWith({ concurrency, queue, timeoutMs }) {
  process.env.PROVER_MAX_CONCURRENCY = String(concurrency);
  process.env.PROVER_MAX_QUEUE = String(queue);
  process.env.PROVER_PROOF_TIMEOUT_MS = String(timeoutMs);
  vi.resetModules();
  return (await import('../src/index.js')).app;
}

describe.skipIf(!hasArtifacts)('a real service that is already full', () => {
  let app;
  beforeAll(async () => {
    app = await serviceWith({ concurrency: 1, queue: 1, timeoutMs: 60_000 });
  }, 120_000);

  const post = () => request(app).post('/prove').send(REQUEST);

  it('sheds with 503 and Retry-After rather than queueing without bound', async () => {
    const responses = await Promise.all([post(), post(), post(), post(), post()]);
    const shed = responses.filter((r) => r.status === 503);

    expect(responses.filter((r) => r.status === 200)).toHaveLength(2);
    expect(shed).toHaveLength(3);
    for (const response of shed) {
      expect(response.headers['retry-after']).toBe('1');
      expect(response.body).toEqual({ error: 'busy', retryAfterSeconds: 1 });
    }
  }, 120_000);

  it('answers /health and /metrics while a real proof is running', async () => {
    // Dispatched, not merely constructed. Then wait for the service to report
    // one proof under way rather than sleeping and hoping.
    const inFlight = [post().then((r) => r.status), post().then((r) => r.status)];
    const started = Date.now();
    while (Date.now() - started < 5_000) {
      // eslint-disable-next-line no-await-in-loop
      const probe = await request(app).get('/metrics');
      if (/square_proofs_started_total\s+[1-9]/.test(probe.text)
        || /square_proof_duration_seconds_count\s+[0-9]/.test(probe.text)) break;
    }

    const health = await request(app).get('/health');
    const metrics = await request(app).get('/metrics');

    expect([200, 503]).toContain(health.status);
    expect(health.body.service).toBe('square-prover');
    expect(metrics.status).toBe(200);
    expect(metrics.text).toContain('square_proof_duration_seconds');

    expect(await Promise.all(inFlight)).toEqual([200, 200]);
  }, 120_000);

  it('takes the next request once the ceiling clears', async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.body.is_compliant).toBe(true);
  }, 120_000);
});

describe.skipIf(!hasArtifacts)('a real proof that outruns its bound', () => {
  let app;
  beforeAll(async () => {
    app = await serviceWith({ concurrency: 1, queue: 1, timeoutMs: 50 });
  }, 120_000);

  it('is answered 504, and the slot is not handed on until the proof stops', async () => {
    const timedOut = await request(app).post('/prove').send(REQUEST);
    expect(timedOut.status).toBe(504);
    expect(String(timedOut.body.error)).toContain('timed out');

    // The next request is admitted once the abandoned proof finishes, and is
    // answered the same way. What must not happen is a second proof starting
    // on top of the first: snarkjs takes no abort signal, so both would be
    // holding their read of the proving key at once.
    const next = await request(app).post('/prove').send(REQUEST);
    expect(next.status).toBe(504);
  }, 120_000);
});

describe.skipIf(hasArtifacts)('back-pressure against real proofs', () => {
  it('skipped: no circuit artifacts present', () => {
    expect(hasArtifacts).toBe(false);
  });
});
