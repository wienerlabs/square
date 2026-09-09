// The proof encoding the on-chain verifier will read.
//
// Getting this wrong does not produce a wrong answer, it produces a proof that
// simply fails to verify — which looks like a broken circuit, a broken key, or
// a broken contract, and is none of those. The Solana service that this one was
// ported from negated pi_a's Y coordinate and reordered pi_b's limbs for
// arkworks; the Solidity verifier snarkjs generates wants neither.
//
// So rather than assert the layout against a description of it, this checks it
// against `snarkjs zkey export soliditycalldata` — the same tool that generates
// the verifier contract, so the two cannot disagree about what it expects.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateProof } from '../src/prover.js';

const ARTIFACTS = process.env.PROVER_ARTIFACTS_DIR
  ? path.resolve(process.env.PROVER_ARTIFACTS_DIR)
  : path.resolve(import.meta.dirname, '..', 'artifacts');

const HAVE_ARTIFACTS = fs.existsSync(path.join(ARTIFACTS, 'payment.wasm'))
  && fs.existsSync(path.join(ARTIFACTS, 'payment.zkey'));

const address = (nibble) => `0x${String(nibble).repeat(40)}`;

const REQUEST = {
  policy_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  // square#45: the secret the eight leaf salts derive from.
  policy_salt: '7777777777777777777777777777777777777777777777777777777777777',
  operator_id: address(3),
  max_daily_spend: '100000000',
  max_per_transaction: '10000000',
  allowed_endpoint_categories: ['api-call'],
  blocked_addresses: [address(2)],
  token_whitelist: [address(4)],
  payment_amount: '5000000',
  payment_token: address(4),
  payment_recipient: address(1),
  payment_endpoint_category: 'api-call',
  daily_spent_before: '50000000',
  current_unix_timestamp: '1788356730',
};

describe.skipIf(!HAVE_ARTIFACTS)('Solidity calldata', () => {
  it('matches what snarkjs generates for the same proof', async () => {
    const result = await generateProof(REQUEST);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-calldata-'));
    try {
      const proofFile = path.join(dir, 'proof.json');
      const publicFile = path.join(dir, 'public.json');
      fs.writeFileSync(proofFile, JSON.stringify(result.raw_proof));
      fs.writeFileSync(publicFile, JSON.stringify(result.raw_public));

      const raw = execFileSync(
        'snarkjs',
        ['zkey', 'export', 'soliditycalldata', publicFile, proofFile],
        { encoding: 'utf8' },
      );
      const words = raw.match(/0x[0-9a-f]{64}/g);

      expect(result.solidity.a).toEqual(words.slice(0, 2));
      expect(result.solidity.b).toEqual([words.slice(2, 4), words.slice(4, 6)]);
      expect(result.solidity.c).toEqual(words.slice(6, 8));
      expect(result.solidity.input).toEqual(words.slice(8));
      expect(result.solidity.input).toHaveLength(8);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('carries the eight public signals in the documented order', async () => {
    const result = await generateProof(REQUEST);
    // The verifier reads them positionally, so the order is the contract.
    const asDecimal = result.solidity.input.map((hex) => BigInt(hex).toString());
    expect(asDecimal).toEqual(result.raw_public);
    expect(asDecimal[0]).toBe('1');                                   // is_compliant
    expect(asDecimal[2]).toBe(BigInt(address(1)).toString());         // recipient
    expect(asDecimal[3]).toBe('5000000');                             // amount
    expect(asDecimal[4]).toBe(BigInt(address(4)).toString());         // token
    expect(asDecimal[5]).toBe('50000000');                            // daily_spent_before
    expect(asDecimal[6]).toBe('1788356730');                          // timestamp
    expect(asDecimal[7]).toBe('0');                                   // stripe_receipt_hash
  });
});

describe.skipIf(HAVE_ARTIFACTS)('Solidity calldata', () => {
  it('skipped: no circuit artifacts present', () => {
    expect(HAVE_ARTIFACTS).toBe(false);
  });
});
