// payment.circom: the six rules, the eight public signals, and a real proof.
//
// The circuit proves that the checks were *performed*, not that they passed —
// a non-compliant payment still produces a valid proof, with is_compliant = 0.
// The contract is what refuses to release on a zero.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildInput, policyDataHash, addressToField, PUBLIC_SIGNALS,
  ADDRESSES, TIMESTAMP,
} from './helpers/inputs.mjs';
import { calculateWitness, isBuilt, wasmPath } from './helpers/witness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.resolve(HERE, '..', 'build');
const ZKEY = path.join(BUILD, 'payment.zkey');
const VKEY = path.join(BUILD, 'payment_vk.json');

const HAVE_WASM = isBuilt('payment');
const HAVE_ZKEY = HAVE_WASM && fs.existsSync(ZKEY) && fs.existsSync(VKEY);

// Witness layout: w[0] = 1, then the public outputs in declaration order.
const signalIndex = (name) => 1 + PUBLIC_SIGNALS.indexOf(name);

describe.skipIf(!HAVE_WASM)('payment.circom', () => {
  async function run(overrides) {
    const input = await buildInput(overrides);
    const witness = await calculateWitness('payment', input);
    const signals = {};
    PUBLIC_SIGNALS.forEach((name, i) => { signals[name] = witness[1 + i]; });
    return { input, witness, signals };
  }

  describe('public signals', () => {
    it('exposes exactly eight, in the documented order', async () => {
      const { witness, signals } = await run({});
      expect(PUBLIC_SIGNALS).toHaveLength(8);
      // w[0] is the constant 1; the ninth slot is already an internal signal.
      expect(witness.length).toBeGreaterThan(9);
      expect(Object.keys(signals)).toEqual(PUBLIC_SIGNALS);
    });

    it('mirrors the payment fields the verifier cross-checks', async () => {
      const { signals } = await run({});
      expect(signals.recipient).toBe(addressToField(ADDRESSES.provider));
      expect(signals.token).toBe(addressToField(ADDRESSES.usdc));
      expect(signals.amount).toBe('5000000');
      expect(signals.daily_spent_before).toBe('50000000');
      expect(signals.current_unix_timestamp).toBe(String(TIMESTAMP));
      expect(signals.stripe_receipt_hash).toBe('0');
    });

    it('carries a whole address in one field element', async () => {
      // The point of the reparameterisation: no high/low split.
      const { signals } = await run({ recipient: ADDRESSES.blocked });
      expect(signals.recipient).toBe(
        BigInt('0x2222222222222222222222222222222222222222').toString(),
      );
    });

    it('commits to the policy the same way the backend must', async () => {
      const { input, signals } = await run({});
      expect(signals.policy_data_hash).toBe(await policyDataHash(input));
    });

    it('changes the commitment when any policy field changes', async () => {
      const base = await run({});
      for (const override of [
        { maxPerTx: '10000001' },
        { maxDaily: '100000001' },
        { blockedAddresses: [ADDRESSES.otherToken] },
        { tokenWhitelist: [ADDRESSES.usdc, ADDRESSES.otherToken] },
        { allowedCategories: ['api-call', 'inference'] },
        { operator: ADDRESSES.provider },
        { policyIdField: '424243' },
      ]) {
        const changed = await run(override);
        expect(
          changed.signals.policy_data_hash,
          `commitment unchanged for ${JSON.stringify(override)}`,
        ).not.toBe(base.signals.policy_data_hash);
      }
    });
  });

  describe('the six rules', () => {
    it('passes a compliant payment', async () => {
      const { signals } = await run({});
      expect(signals.is_compliant).toBe('1');
    });

    it('rule 1: rejects an amount over the per-transaction ceiling', async () => {
      const { signals } = await run({ amount: '10000001', dailySpentBefore: '0' });
      expect(signals.is_compliant).toBe('0');
    });

    it('rule 1: allows an amount exactly on the ceiling', async () => {
      const { signals } = await run({ amount: '10000000', dailySpentBefore: '0' });
      expect(signals.is_compliant).toBe('1');
    });

    it('rule 2: rejects a payment that would cross the daily ceiling', async () => {
      const { signals } = await run({ amount: '5000000', dailySpentBefore: '95000001' });
      expect(signals.is_compliant).toBe('0');
    });

    it('rule 2: allows a payment that lands exactly on the daily ceiling', async () => {
      const { signals } = await run({ amount: '5000000', dailySpentBefore: '95000000' });
      expect(signals.is_compliant).toBe('1');
    });

    it('rule 3: rejects a token that is not whitelisted', async () => {
      const { signals } = await run({ token: ADDRESSES.otherToken });
      expect(signals.is_compliant).toBe('0');
    });

    it('rule 3: refuses the zero address outright rather than matching padding', async () => {
      // Padding slots hold zero, so a zero lookup key would match one. The
      // circuit rejects the witness instead of quietly answering 0 — the
      // constraint is what lets the mask arrays go.
      await expect(run({ token: '0x0000000000000000000000000000000000000000' }))
        .rejects.toThrow();
    });

    it('rule 4: refuses a zero recipient', async () => {
      await expect(run({ recipient: '0x0000000000000000000000000000000000000000' }))
        .rejects.toThrow();
    });

    it('rule 4: a blocked entry cannot be switched off', async () => {
      // The bypass this replaced: the lists used to carry parallel mask arrays
      // that policy_data_hash did not commit to, so zeroing blocked_addresses_mask
      // left the commitment byte-identical while rule 4 stopped matching. There
      // is no mask to zero now, and an unknown input is rejected.
      const input = await buildInput({ recipient: ADDRESSES.blocked });
      expect(input.blocked_addresses_mask).toBeUndefined();
      await expect(
        calculateWitness('payment', { ...input, blocked_addresses_mask: Array(10).fill('0') }),
      ).rejects.toThrow();
    });

    it('rule 4: rejects a blocked recipient', async () => {
      const { signals } = await run({ recipient: ADDRESSES.blocked });
      expect(signals.is_compliant).toBe('0');
    });

    it('rule 5: rejects a category that is not allowed', async () => {
      const { signals } = await run({ paymentCategory: 'exfiltration' });
      expect(signals.is_compliant).toBe('0');
    });

    it('reports zero when several rules fail at once', async () => {
      const { signals } = await run({
        amount: '999999999',
        token: ADDRESSES.otherToken,
        recipient: ADDRESSES.blocked,
      });
      expect(signals.is_compliant).toBe('0');
    });
  });

  describe('rule 6, the time window', () => {
    // TIMESTAMP is Wednesday 13:45 UTC. Mon=0, so Wednesday is bit 2.
    const WEDNESDAY = 1 << 2;
    const THURSDAY = 1 << 3;

    it('is a free pass when no window is configured', async () => {
      const { signals } = await run({ timeActive: '0' });
      expect(signals.is_compliant).toBe('1');
    });

    it('passes inside the window', async () => {
      const { signals } = await run({
        timeActive: '1', timeDaysBitmask: String(WEDNESDAY),
        timeStartHourUtc: '9', timeEndHourUtc: '17',
      });
      expect(signals.is_compliant).toBe('1');
    });

    it('rejects a day the policy does not allow', async () => {
      const { signals } = await run({
        timeActive: '1', timeDaysBitmask: String(THURSDAY),
        timeStartHourUtc: '0', timeEndHourUtc: '23',
      });
      expect(signals.is_compliant).toBe('0');
    });

    it('rejects an hour before the window opens', async () => {
      const { signals } = await run({
        timeActive: '1', timeDaysBitmask: String(WEDNESDAY),
        timeStartHourUtc: '14', timeEndHourUtc: '17',
      });
      expect(signals.is_compliant).toBe('0');
    });

    it('rejects an hour after the window closes', async () => {
      const { signals } = await run({
        timeActive: '1', timeDaysBitmask: String(WEDNESDAY),
        timeStartHourUtc: '9', timeEndHourUtc: '12',
      });
      expect(signals.is_compliant).toBe('0');
    });

    it('accepts the boundary hours', async () => {
      for (const [start, end] of [['13', '13'], ['13', '23'], ['0', '13']]) {
        const { signals } = await run({
          timeActive: '1', timeDaysBitmask: String(WEDNESDAY),
          timeStartHourUtc: start, timeEndHourUtc: end,
        });
        expect(signals.is_compliant, `window ${start}..${end}`).toBe('1');
      }
    });
  });

  describe('range bounds', () => {
    it('refuses an amount at or beyond 2^64', async () => {
      // LessEqThan(64) is only meaningful below 2^64, so the circuit enforces
      // the bound rather than assuming it. See docs/decisions/erc20-vs-native-usdc.md.
      await expect(run({ amount: (2n ** 64n).toString() })).rejects.toThrow();
    });

    it('refuses a daily-spent figure at or beyond 2^64', async () => {
      await expect(run({ dailySpentBefore: (2n ** 64n).toString() })).rejects.toThrow();
    });

    it('accepts the largest amount the interface can express', async () => {
      const max = (2n ** 64n - 1n).toString();
      const { signals } = await run({
        amount: max, maxPerTx: max, maxDaily: max, dailySpentBefore: '0',
      });
      expect(signals.is_compliant).toBe('1');
      expect(signals.amount).toBe(max);
    });
  });
});

describe.skipIf(!HAVE_ZKEY)('proof round trip', () => {
  it('produces a proof that verifies against the development key', async () => {
    const snarkjs = await import('snarkjs');
    const input = await buildInput({});
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input, wasmPath('payment'), ZKEY,
    );

    expect(publicSignals).toHaveLength(8);
    expect(publicSignals[0]).toBe('1');

    const vkey = JSON.parse(fs.readFileSync(VKEY, 'utf8'));
    expect(vkey.nPublic).toBe(8);
    await expect(snarkjs.groth16.verify(vkey, publicSignals, proof)).resolves.toBe(true);
  });

  it('still produces a verifying proof for a non-compliant payment', async () => {
    const snarkjs = await import('snarkjs');
    const input = await buildInput({ token: ADDRESSES.otherToken });
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input, wasmPath('payment'), ZKEY,
    );
    expect(publicSignals[0]).toBe('0');
    const vkey = JSON.parse(fs.readFileSync(VKEY, 'utf8'));
    await expect(snarkjs.groth16.verify(vkey, publicSignals, proof)).resolves.toBe(true);
  });

  it('rejects a proof whose public signals were tampered with', async () => {
    const snarkjs = await import('snarkjs');
    const input = await buildInput({ token: ADDRESSES.otherToken });
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input, wasmPath('payment'), ZKEY,
    );
    const tampered = [...publicSignals];
    tampered[0] = '1'; // flip is_compliant
    const vkey = JSON.parse(fs.readFileSync(VKEY, 'utf8'));
    await expect(snarkjs.groth16.verify(vkey, tampered, proof)).resolves.toBe(false);
  });
});
