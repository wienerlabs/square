// The prover and the circuit have to agree, byte for byte.
//
// Everything else in this service is downstream of one thing: the witness it
// builds is the witness the circuit expects. If the encoding drifts — an
// address folded the old way, a list padded with the wrong sentinel, the policy
// commitment hashed in a different order — the service still produces proofs,
// and they still verify. They just prove a statement about a policy nobody
// committed to. That failure is silent, which is why it is checked against the
// compiled circuit here rather than against a second copy of the same
// assumptions.
//
// The circuit is the source of truth. These tests run its wasm.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildCircuitInput } from '../src/prover.js';
import { poseidon } from '../src/hash.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CIRCUIT_BUILD = path.resolve(HERE, '..', '..', '..', 'circuits', 'build');
const WASM = path.join(CIRCUIT_BUILD, 'payment_js', 'payment.wasm');
const HAVE_CIRCUIT = fs.existsSync(WASM);

const require = createRequire(import.meta.url);

// Public signals in the order payment.circom declares them.
const PUBLIC_SIGNALS = [
  'is_compliant', 'policy_data_hash', 'recipient', 'amount', 'token',
  'daily_spent_before', 'current_unix_timestamp', 'stripe_receipt_hash',
];

const ADDR = {
  usdc: '0x3600000000000000000000000000000000000000',
  other: '0x00000000000000000000000000000000000000ff',
  provider: '0x1111111111111111111111111111111111111111',
  blocked: '0x2222222222222222222222222222222222222222',
  operator: '0x3333333333333333333333333333333333333333',
};

// 2026-09-02T13:45:30Z, a Wednesday at 13:45 UTC.
const TIMESTAMP = '1788356730';

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

let calculator = null;
async function witnessFor(req) {
  if (!calculator) {
    const dir = path.join(CIRCUIT_BUILD, 'payment_js');
    const source = path.join(dir, 'witness_calculator.js');
    const commonjs = path.join(dir, 'witness_calculator.cjs');
    // circom emits CommonJS that also relies on sloppy-mode globals; a
    // "type": "module" package cannot load it as-is.
    if (!fs.existsSync(commonjs)
      || fs.statSync(commonjs).mtimeMs < fs.statSync(source).mtimeMs) {
      fs.copyFileSync(source, commonjs);
    }
    calculator = await require(commonjs)(fs.readFileSync(WASM));
  }
  const witness = await calculator.calculateWitness(await buildCircuitInput(req), true);
  const signals = {};
  PUBLIC_SIGNALS.forEach((name, i) => { signals[name] = witness[1 + i].toString(); });
  return signals;
}

describe.skipIf(!HAVE_CIRCUIT)('the prover agrees with the circuit', () => {
  it('produces a witness the circuit accepts, with eight public signals', async () => {
    const signals = await witnessFor(request());
    expect(Object.keys(signals)).toHaveLength(8);
    expect(signals.is_compliant).toBe('1');
  });

  it('encodes addresses as single field elements', async () => {
    // The change that took the layout from ten signals to eight. A whole
    // address, not a high half.
    const signals = await witnessFor(request());
    expect(signals.recipient).toBe(BigInt(ADDR.provider).toString());
    expect(signals.token).toBe(BigInt(ADDR.usdc).toString());
  });

  it('mirrors the payment fields the contract cross-checks', async () => {
    const signals = await witnessFor(request());
    expect(signals.amount).toBe('5000000');
    expect(signals.daily_spent_before).toBe('50000000');
    expect(signals.current_unix_timestamp).toBe(TIMESTAMP);
    expect(signals.stripe_receipt_hash).toBe('0');
  });

  it('computes the policy commitment the circuit computes', async () => {
    // The load-bearing one. The hook compares this against the registry, so a
    // service that hashes the policy differently binds every proof it makes to
    // a policy nobody committed to.
    const input = await buildCircuitInput(request());
    const signals = await witnessFor(request());

    const timeField = BigInt(input.time_active) === 0n
      ? '0'
      : await poseidon([
        input.time_active, input.time_days_bitmask,
        input.time_start_hour_utc, input.time_end_hour_utc,
      ]);

    // square#45: eight salted, position-separated leaves, and the root is the
    // commitment. Written out here rather than imported from
    // src/commitment.js on purpose — a test that shares an implementation with
    // the thing it is testing shows only that the code equals itself.
    const values = [
      input.max_daily,
      input.max_per_tx,
      input.operator_id_field,
      input.policy_id_field,
      await poseidon(input.allowed_categories),
      await poseidon(input.blocked_addresses),
      await poseidon(input.token_whitelist),
      timeField,
    ];
    const leaves = [];
    for (let i = 0; i < 8; i++) {
      leaves.push(await poseidon([String(i), input.policy_salts[i], values[i]]));
    }
    const expected = await poseidon(leaves);

    expect(signals.policy_data_hash).toBe(expected);
  });

  it('moves the commitment when any committed field moves', async () => {
    const base = await witnessFor(request());
    const overrides = [
      { max_per_transaction: '10000001' },
      { max_daily_spend: '100000001' },
      { blocked_addresses: [ADDR.other] },
      { token_whitelist: [ADDR.usdc, ADDR.other] },
      { allowed_endpoint_categories: ['api-call', 'inference'] },
      { operator_id: ADDR.provider },
      { policy_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3302' },
      {
        time_restrictions: [{
          allowed_days: ['wednesday'], allowed_hours_start: 9,
          allowed_hours_end: 17, timezone: 'UTC',
        }],
      },
    ];
    for (const override of overrides) {
      const changed = await witnessFor(request(override));
      expect(
        changed.policy_data_hash,
        `commitment unchanged for ${JSON.stringify(override)}`,
      ).not.toBe(base.policy_data_hash);
    }
  });

  it('reports the same compliance verdict the circuit does, rule by rule', async () => {
    const cases = [
      [{}, '1'],
      [{ payment_amount: '10000001', daily_spent_before: '0' }, '0'],
      [{ daily_spent_before: '95000001' }, '0'],
      [{ payment_token: ADDR.other }, '0'],
      [{ payment_recipient: ADDR.blocked }, '0'],
      [{ payment_endpoint_category: 'exfiltration' }, '0'],
    ];
    for (const [override, expected] of cases) {
      const signals = await witnessFor(request(override));
      expect(signals.is_compliant, JSON.stringify(override)).toBe(expected);
    }
  });

  it('agrees with the circuit on the time window', async () => {
    // TIMESTAMP is a Wednesday at 13:45 UTC.
    const inWindow = await witnessFor(request({
      time_restrictions: [{
        allowed_days: ['wednesday'], allowed_hours_start: 9,
        allowed_hours_end: 17, timezone: 'UTC',
      }],
    }));
    expect(inWindow.is_compliant).toBe('1');

    const wrongDay = await witnessFor(request({
      time_restrictions: [{
        allowed_days: ['thursday'], allowed_hours_start: 0,
        allowed_hours_end: 23, timezone: 'UTC',
      }],
    }));
    expect(wrongDay.is_compliant).toBe('0');

    const wrongHour = await witnessFor(request({
      time_restrictions: [{
        allowed_days: ['wednesday'], allowed_hours_start: 14,
        allowed_hours_end: 17, timezone: 'UTC',
      }],
    }));
    expect(wrongHour.is_compliant).toBe('0');
  });

  it('is rejected by the circuit when an amount exceeds the 64-bit bound', async () => {
    // The circuit range-checks both amount operands, so an 18-decimal figure
    // fails here rather than wrapping into a comparison that passes.
    await expect(witnessFor(request({ payment_amount: (2n ** 64n).toString() })))
      .rejects.toThrow();
  });

  it('is rejected by the circuit when a lookup key is the zero address', async () => {
    await expect(witnessFor(request({ payment_token: `0x${'0'.repeat(40)}` })))
      .rejects.toThrow();
  });

  it('has no mask arrays left to switch a rule off with', async () => {
    // The bypass #14 removed: masks were not covered by policy_data_hash, so
    // zeroing one turned off rule 4 while the commitment stayed identical.
    const input = await buildCircuitInput(request());
    expect(input.blocked_addresses_mask).toBeUndefined();
    expect(input.token_whitelist_mask).toBeUndefined();
    expect(input.allowed_categories_mask).toBeUndefined();
  });
});

describe.skipIf(HAVE_CIRCUIT)('the prover agrees with the circuit', () => {
  it('skipped: compile the circuit first (cd circuits && npm run build -- --no-zkey)', () => {
    expect(HAVE_CIRCUIT).toBe(false);
  });
});
