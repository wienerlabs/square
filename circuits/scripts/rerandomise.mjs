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
// The output of this script is the `compliant_rerandomised` fixture, and
// contracts/test/Malleability.t.sol feeds it to src/Groth16Verifier.sol.
//
//   node scripts/rerandomise.mjs <proofs.json> <vk.json> <key> <Groth16Verifier.sol>
//
// delta comes from the verifier's own source, not from a local vk: every build
// produces a different phase-2 key and delta is exactly the point that moves,
// so a locally built vk's delta belongs to a different verifier. Reading it
// from the wrong place is a silent failure — the copy simply does not verify —
// and it is how the first attempt at this went wrong.
import { readFileSync } from 'node:fs';
import { bn254 } from '@noble/curves/bn254';

const { G1, G2, fields } = bn254;
const Fr = fields.Fr;

const fixtures = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const p = fixtures[process.argv[4] ?? 'compliant'];

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

// delta has to come from the verifier the proof will be checked against, not
// from a local build: every build produces a different phase-2 key and delta is
// exactly the point that moves. The vk file beside this script is a different
// key from the one src/Groth16Verifier.sol was generated from.
const src = readFileSync(process.argv[5], 'utf8');
const constant = (name) => BigInt(new RegExp(name + '\\s*=\\s*(\\d+)').exec(src)[1]);
const delta2 = G2.Point.fromAffine({
  x: { c0: constant('DELTA_X_RE'), c1: constant('DELTA_X_IM') },
  y: { c0: constant('DELTA_Y_RE'), c1: constant('DELTA_Y_IM') },
});
delta2.assertValidity();

const A = g1(p.a);
const B = g2FromSolidity(p.b);
const C = g1(p.c);

const r = Fr.create(BigInt('0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')));
const s = Fr.create(BigInt('0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')));
const rInv = Fr.inv(r);

const A2 = A.multiply(r);
const B2 = B.multiply(rInv).add(delta2.multiply(s));
const C2 = C.add(A.multiply(Fr.mul(r, s)));

console.log(JSON.stringify({
  r: r.toString(), s: s.toString(),
  a: g1ToSolidity(A2), b: g2ToSolidity(B2), c: g1ToSolidity(C2),
  input: p.input.map((h) => big(h).toString()),
}, null, 2));

process.exit(0);
