#!/usr/bin/env node
// Re-randomise a Groth16 proof: the same eight public signals, different bytes.
//
// This exists because a claim about a verifier is worth measuring against that
// verifier. The review of square#27 pointed out that ComplianceModule marked
// spent proofs by `keccak256(proof)`, and that a Groth16 proof is not bound to
// its own encoding:
//
//   A' = r·A        B' = r⁻¹·B + s·δ        C' = C + (r·s)·A
//
// verifies for the same public inputs, because
// e(A',B') = e(A,B)·e(rs·A, δ) and C' absorbs the difference. The verifier
// checks the pairing and the signals' field membership, nothing about the
// encoding, so it accepts the copy — and a mark on the bytes never sees it.
//
// contracts/script/regenerate-fixtures.mjs imports `rerandomise` to write the
// `compliant_rerandomised` fixture, with delta from the key that produced
// `compliant`, and contracts/test/Malleability.t.sol feeds it to
// src/Groth16Verifier.sol. square#271: it used to be written by hand from this
// script's output, so regenerating the fixtures deleted it.
//
//   node scripts/rerandomise.mjs <proofs.json> <vk.json> <key> <Groth16Verifier.sol>
//
// delta comes from the verifier's own source, not from a local vk: every build
// produces a different phase-2 key and delta is exactly the point that moves,
// so a locally built vk's delta belongs to a different verifier. Reading it
// from the wrong place is a silent failure — the copy simply does not verify —
// and it is how the first attempt at this went wrong.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bn254 } from '@noble/curves/bn254';

const { G1, G2, fields } = bn254;
const Fr = fields.Fr;

const big = (x) => BigInt(x);
const g1 = (pair) => G1.Point.fromAffine({ x: big(pair[0]), y: big(pair[1]) });
// The Solidity calldata carries G2 as (x_im, x_re), (y_im, y_re); noble wants
// Fp2 as { c0: re, c1: im }.
const g2FromSolidity = (b) => G2.Point.fromAffine({
  x: { c0: big(b[0][1]), c1: big(b[0][0]) },
  y: { c0: big(b[1][1]), c1: big(b[1][0]) },
});
const g2ToSolidity = (P) => {
  const a = P.toAffine();
  return [[a.x.c1.toString(), a.x.c0.toString()], [a.y.c1.toString(), a.y.c0.toString()]];
};
const g1ToSolidity = (P) => { const a = P.toAffine(); return [a.x.toString(), a.y.toString()]; };

const randomScalar = () => Fr.create(
  BigInt('0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')),
);

// delta as a verifier's constants spell it.
export function deltaFromVerifierSource(src) {
  const constant = (name) => BigInt(new RegExp(name + '\\s*=\\s*(\\d+)').exec(src)[1]);
  return G2.Point.fromAffine({
    x: { c0: constant('DELTA_X_RE'), c1: constant('DELTA_X_IM') },
    y: { c0: constant('DELTA_Y_RE'), c1: constant('DELTA_Y_IM') },
  });
}

// delta as snarkjs writes it into a verification key: [[x_re, x_im], [y_re, y_im], [1, 0]].
export function deltaFromVerificationKey(vk) {
  const [x, y] = vk.vk_delta_2;
  return G2.Point.fromAffine({
    x: { c0: big(x[0]), c1: big(x[1]) },
    y: { c0: big(y[0]), c1: big(y[1]) },
  });
}

// `proof` is in the verifier's calldata layout ({ a, b, c, input }); the copy
// comes back in the same layout, as decimal strings, with the r and s drawn.
export function rerandomise(proof, delta2) {
  delta2.assertValidity();

  const A = g1(proof.a);
  const B = g2FromSolidity(proof.b);
  const C = g1(proof.c);

  const r = randomScalar();
  const s = randomScalar();
  const rInv = Fr.inv(r);

  const A2 = A.multiply(r);
  const B2 = B.multiply(rInv).add(delta2.multiply(s));
  const C2 = C.add(A.multiply(Fr.mul(r, s)));

  return {
    r: r.toString(), s: s.toString(),
    a: g1ToSolidity(A2), b: g2ToSolidity(B2), c: g1ToSolidity(C2),
    input: proof.input.map((h) => big(h).toString()),
  };
}

const invokedDirectly = process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const fixtures = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const p = fixtures[process.argv[4] ?? 'compliant'];

  // delta has to come from the verifier the proof will be checked against, not
  // from a local build: every build produces a different phase-2 key and delta is
  // exactly the point that moves. The vk file beside this script is a different
  // key from the one src/Groth16Verifier.sol was generated from.
  const delta2 = deltaFromVerifierSource(readFileSync(process.argv[5], 'utf8'));

  console.log(JSON.stringify(rerandomise(p, delta2), null, 2));

  process.exit(0);
}
