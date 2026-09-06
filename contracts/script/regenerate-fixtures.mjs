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

const out = {};
for (const [name, overrides] of Object.entries(CASES)) {
  const result = await generateProof({ ...BASE, ...overrides });
  out[name] = { is_compliant: result.is_compliant, ...result.solidity };
  process.stdout.write(`${name.padEnd(10)} is_compliant=${result.is_compliant}\n`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
process.stdout.write(`\nwrote ${path.relative(ROOT, OUT)}\n`);
