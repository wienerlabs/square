// End-to-end over the real route, with a real Groth16 prove.
//
// The unit tests hold the logging decision to its allowlist. This one closes
// the loop: it drives POST /prove with a genuinely non-compliant payment, lets
// snarkjs produce a real proof against the real circuit, and reads back
// everything the service actually wrote to stdout and stderr. No stubs — the
// only thing intercepted is `console`, so the test can see what an operator's
// log would have received.
//
// It needs the compiled circuit and a proving key, which are not in the
// repository: `*.zkey` is gitignored and the circuit itself arrives with #14.
// Build them and point PROVER_ARTIFACTS_DIR at the result — see
// services/prover/README.md — and the suite runs. Without them it skips rather
// than pretending to pass.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = process.env.PROVER_ARTIFACTS_DIR
  ? path.resolve(process.env.PROVER_ARTIFACTS_DIR)
  : path.resolve(HERE, '..', 'artifacts');

const hasArtifacts =
  fs.existsSync(path.join(ARTIFACTS, 'payment.wasm')) &&
  fs.existsSync(path.join(ARTIFACTS, 'payment.zkey'));

const address = (nibble) => `0x${String(nibble).repeat(40)}`;

const SECRET = {
  maxDaily: '987654321987',
  maxPerTx: '123454321123',
  dailySpentBefore: '55555555555',
  blockedA: address(2),
  whitelistA: address(4),
  categoryA: 'super-secret-category',
  operator: address(3),
};

// Over the per-transaction ceiling and over the daily ceiling, paying a mint
// that is not on the whitelist: three rules broken at once.
const NON_COMPLIANT_REQUEST = {
  policy_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  operator_id: SECRET.operator,
  max_daily_spend: SECRET.maxDaily,
  max_per_transaction: SECRET.maxPerTx,
  allowed_endpoint_categories: [SECRET.categoryA],
  blocked_addresses: [SECRET.blockedA],
  token_whitelist: [SECRET.whitelistA],
  payment_amount: '999999999999',
  payment_token: address(9),
  payment_recipient: address(1),
  payment_endpoint_category: SECRET.categoryA,
  daily_spent_before: SECRET.dailySpentBefore,
  current_unix_timestamp: '1788356730',
};

const FORBIDDEN_IN_LOGS = [
  SECRET.maxDaily,
  SECRET.maxPerTx,
  SECRET.dailySpentBefore,
  SECRET.blockedA,
  SECRET.whitelistA,
  SECRET.categoryA,
];

describe.skipIf(!hasArtifacts)('POST /prove, real proof', () => {
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

  it('proves a non-compliant payment and logs no private policy', async () => {
    capture();
    const response = await request(app).post('/prove').send(NON_COMPLIANT_REQUEST);
    console.log = original.log;
    console.error = original.error;

    expect(response.status).toBe(200);
    expect(response.body.is_compliant).toBe(false);
    expect(response.body.violated_rules).toEqual(
      expect.arrayContaining(['per_transaction_limit', 'daily_limit', 'token_whitelist']),
    );
    // A proof is still produced: the circuit proves the check ran, not that the
    // outcome was positive.
    expect(response.body.solidity.a).toHaveLength(2);
    expect(response.body.solidity.input).toHaveLength(8);
    expect(response.body.raw_public).toHaveLength(8);

    const logs = captured.join('\n');
    expect(logs).toContain('"event":"compliance_violation"');
    expect(logs).toContain('"violated_rules"');
    expect(logs).toContain(SECRET.operator);
    for (const value of FORBIDDEN_IN_LOGS) {
      expect(logs, `leaked ${value}`).not.toContain(value);
    }
    // The old event name must never come back.
    expect(logs).not.toContain('compliance_violation_input');
    // And no divergence: the off-circuit evaluator agreed with the circuit.
    expect(logs).not.toContain('rule_evaluation_divergence');
  });

  it('proves a compliant payment and logs no violation at all', async () => {
    const compliant = {
      ...NON_COMPLIANT_REQUEST,
      payment_token: SECRET.whitelistA,
      payment_amount: '1000',
      daily_spent_before: '0',
    };

    capture();
    const response = await request(app).post('/prove').send(compliant);
    console.log = original.log;
    console.error = original.error;

    expect(response.status).toBe(200);
    expect(response.body.is_compliant).toBe(true);
    expect(response.body.violated_rules).toEqual([]);

    const logs = captured.join('\n');
    expect(logs).toContain('"event":"proof_generated"');
    expect(logs).not.toContain('compliance_violation');
    for (const value of FORBIDDEN_IN_LOGS) {
      expect(logs, `leaked ${value}`).not.toContain(value);
    }
  });

  it('reports a malformed blocked address without echoing it', async () => {
    const malformed = { ...NON_COMPLIANT_REQUEST, blocked_addresses: ['not-base58-!!!'] };

    capture();
    const response = await request(app).post('/prove').send(malformed);
    console.log = original.log;
    console.error = original.error;

    expect(response.status).toBe(500);
    expect(response.body.error).toContain('blocked_addresses');
    expect(response.body.error).not.toContain('not-base58-!!!');
    expect(captured.join('\n')).not.toContain('not-base58-!!!');
  });
});

describe.skipIf(hasArtifacts)('POST /prove, real proof', () => {
  it('skipped: no circuit artifacts present', () => {
    expect(hasArtifacts).toBe(false);
  });
});
