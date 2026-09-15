import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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

  // A proof the service itself could not produce: its artifacts are not where it
  // looks. That is this service's failure, so it is 500 and it is counted.
  //
  // This used to send a malformed blocked address, which square#251 moved to the
  // gate, where it is the caller's 400 and counts nothing. A valid request cannot
  // stand in for it either, because a runner with the artifacts present would
  // prove it. So the service is loaded again with its artifact directory pointed
  // at an empty one, which fails the same way on every runner. Each load has its
  // own metrics registry, so the count is that instance's.
  it('counts a failed proof', async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'square-prover-no-artifacts-'));
    vi.stubEnv('PROVER_ARTIFACTS_DIR', empty);
    vi.resetModules();
    try {
      const { app: unprovable } = await import('../src/index.js');
      const count = async () => {
        const response = await request(unprovable).get('/metrics');
        const match = /square_proof_failures_total\{[^}]*\} (\d+)/.exec(response.text);
        return match ? Number(match[1]) : 0;
      };
      const before = await count();
      const response = await request(unprovable).post('/prove').send(VALID_SHAPE);
      expect(response.status).toBe(500);
      expect(await count()).toBe(before + 1);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      rmSync(empty, { recursive: true, force: true });
    }
  });

  // What this test used to send, now that it is refused at the gate.
  it('does not count a malformed field as a failed proof', async () => {
    const before = await failures();
    const response = await request(app)
      .post('/prove')
      .send({ ...VALID_SHAPE, blocked_addresses: ['not-an-address'] });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('blocked_addresses: must be a 20-byte hex address');
    expect(await failures()).toBe(before);
  });

  // square#253. The zero address is well formed, so it passed the gate, failed in
  // the rule evaluator with a message that named nothing, and was counted as
  // witness_failed: the reason that reads as a broken proving key or circuit.
  it('refuses a zero payment_token or payment_recipient by name, and counts neither as witness_failed', async () => {
    const witnessFailed = async () => {
      const response = await request(app).get('/metrics');
      const match = /square_proof_failures_total\{[^}]*reason="witness_failed"[^}]*\} (\d+)/.exec(response.text);
      return match ? Number(match[1]) : 0;
    };
    for (const field of ['payment_token', 'payment_recipient']) {
      const before = { all: await failures(), witness: await witnessFailed() };
      const response = await request(app)
        .post('/prove')
        .send({ ...VALID_SHAPE, [field]: `0x${'0'.repeat(40)}` });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe(`${field}: must not be the zero address; the circuit rejects a zero lookup key`);
      expect(await witnessFailed()).toBe(before.witness);
      expect(await failures()).toBe(before.all);
    }
  });

  it('does not count a refused request as a failed proof', async () => {
    const before = await failures();
    const response = await request(app).post('/prove').send({});
    expect(response.status).toBe(400);
    expect(await failures()).toBe(before);
  });
});
