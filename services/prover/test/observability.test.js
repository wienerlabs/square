import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/index.js';

describe('observability endpoints', () => {
  it('serves health with the artifact check, and the check is critical', async () => {
    const response = await request(app).get('/health');
    expect([200, 503]).toContain(response.status);
    expect(response.body.service).toBe('square-prover');
    expect(response.body.checks.artifacts).toBeDefined();
    expect(response.body.checks.artifacts.critical).toBe(true);
    expect(response.status).toBe(response.body.checks.artifacts.ok ? 200 : 503);
    expect(response.body.status).toBe(response.body.checks.artifacts.ok ? 'healthy' : 'unhealthy');
  });

  it('serves Prometheus metrics with the proof signals', async () => {
    const response = await request(app).get('/metrics');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.text).toContain('square_proof_duration_seconds');
    expect(response.text).toContain('square_proof_failures_total');
  });

  it('serves version', async () => {
    const response = await request(app).get('/version');
    expect(response.status).toBe(200);
    expect(response.body.service).toBe('square-prover');
    expect(response.body.version).toBe('0.1.0');
  });

  // square#148 split these two. The empty body this used to send is now refused
  // by validateRequest with 400, and a refused policy is not a failed proof: a
  // caller's mistyped hour has no business in the service's failure rate, which
  // is what an operator pages on. So the counter is asserted against a request
  // that gets past the gate and fails afterwards, and asserted *not* to move for
  // one that never got past it.
  const failures = async () => {
    const response = await request(app).get('/metrics');
    const match = /square_proof_failures_total\{[^}]*\} (\d+)/.exec(response.text);
    return match ? Number(match[1]) : 0;
  };

  const VALID_SHAPE = {
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
  };

  it('counts a failed proof', async () => {
    const before = await failures();
    // Passes validateRequest — blocked_addresses is an array of strings — and
    // fails in normalize, which is inside the proving path. No artifacts needed.
    const response = await request(app)
      .post('/prove')
      .send({ ...VALID_SHAPE, blocked_addresses: ['not-an-address'] });
    expect(response.status).toBe(500);
    expect(await failures()).toBe(before + 1);
  });

  it('does not count a refused request as a failed proof', async () => {
    const before = await failures();
    const response = await request(app).post('/prove').send({});
    expect(response.status).toBe(400);
    expect(await failures()).toBe(before);
  });
});
