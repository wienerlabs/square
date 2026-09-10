#!/usr/bin/env node
// Regenerate test/fixtures/proofs.json from the prover service.
//
// The verifier tests run against proofs the service actually produced, not
// against values written by hand for the test. A verifier checked with proofs
// invented alongside it demonstrates that the test and its author agree, which
// is not the property anyone needs — the property is that what the prover emits
// is what the chain accepts.
//
// Run this whenever the circuit, the proving key or the proof encoding changes.
// All three invalidate the fixtures, and a stale fixture fails loudly rather
// than silently, because a proof for a different circuit does not verify.
//
//   PROVER_ARTIFACTS_DIR=/path/to/artifacts node script/regenerate-fixtures.mjs
//
// The artifacts are payment.wasm and payment.zkey — see circuits/README.md.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'test', 'fixtures', 'proofs.json');

const { generateProof } = await import(
  path.resolve(ROOT, '..', 'services', 'prover', 'src', 'prover.js')
);

const USDC = '0x3600000000000000000000000000000000000000';
const BLOCKED = '0x2222222222222222222222222222222222222222';

// Fixed values, so a regenerated fixture differs only where the proof does.
// The test asserts these back out of the public signals.
const BASE = {
  policy_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  // square#45: the secret the eight leaf salts derive from. Fixed, so a
  // regenerated fixture differs only where the proof does.
  policy_salt: '7777777777777777777777777777777777777777777777777777777777777',
  // square#45: the secret the eight leaf salts derive from. Fixed, so a
  // regenerated fixture differs only where the proof does.
  policy_salt: '7777777777777777777777777777777777777777777777777777777777777',
  operator_id: '0x3333333333333333333333333333333333333333',
  max_daily_spend: '100000000',
  max_per_transaction: '10000000',
  allowed_endpoint_categories: ['api-call'],
  blocked_addresses: [BLOCKED],
  token_whitelist: [USDC],
  payment_token: USDC,
  payment_amount: '5000000',
  daily_spent_before: '50000000',
  payment_endpoint_category: 'api-call',
  current_unix_timestamp: '1788356730',
};

const CASES = {
  // Passes all six rules.
  compliant: { payment_recipient: '0x1111111111111111111111111111111111111111' },
  // Fails rule 4. Still produces a valid proof — the circuit proves the check
  // ran, not that it passed — so the verifier accepts it and the hook is what
  // refuses to release.
  blocked: { payment_recipient: BLOCKED },
};

// Which key these proofs came from.
//
// square#121: the committed constants and the committed fixtures both descend
// from one zkey, and nothing recorded which. The zkey is gitignored — 2.8 MB of
// generated output — so its digest is the only way to say afterwards that a
// verifier and a set of fixtures belong together. `null` here means the file was
// not present when this ran, which is worth seeing rather than papering over.
const artifacts = process.env.PROVER_ARTIFACTS_DIR
  ? path.resolve(process.env.PROVER_ARTIFACTS_DIR)
  : path.resolve(ROOT, '..', 'services', 'prover', 'artifacts');
const zkey = path.join(artifacts, 'payment.zkey');
const zkeySha256 = fs.existsSync(zkey)
  ? crypto.createHash('sha256').update(fs.readFileSync(zkey)).digest('hex')
  : null;

const proofs = {};
for (const [name, overrides] of Object.entries(CASES)) {
  const result = await generateProof({ ...BASE, ...overrides });
  proofs[name] = { is_compliant: result.is_compliant, ...result.solidity };
  process.stdout.write(`${name.padEnd(10)} is_compliant=${result.is_compliant}\n`);
}

const out = {
  _provenance: {
    zkey_sha256: zkeySha256,
    generated_at: new Date().toISOString(),
    note:
      'The verifier in src/Groth16Verifier.sol must come from this same key. '
      + 'Regenerate both together: a verifier from one key rejects every proof '
      + 'from another.',
  },
  ...proofs,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
process.stdout.write(
  `
wrote ${path.relative(ROOT, OUT)}
`
  + `zkey sha256 ${zkeySha256 ?? '(the key was not on disk; recorded as null)'}
`,
);

// snarkjs leaves handles open after fullProve — a worker pool it does not tear
// down — so the process finishes its work and then sits there. Every byte is on
// disk by this line; anything still running is not ours to wait for, and a
// script that never returns hangs whatever called it.
process.exit(0);
