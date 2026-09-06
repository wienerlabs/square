// Shape a snarkjs proof into the arguments an on-chain Groth16 verifier takes.
//
// This replaces the groth16-solana encoding the Solana service used. That one
// negated pi_a's Y coordinate and reordered pi_b's Fp2 limbs, because the Rust
// verifier expected arkworks byte layout. The Solidity verifier snarkjs
// generates does neither: it negates internally, and it reads pi_b in the order
// snarkjs already emits.
//
// Getting this wrong does not produce a wrong answer — it produces a proof that
// simply fails to verify, which is a confusing way to lose an afternoon. The
// layout below is the one `snarkjs zkey export soliditycalldata` produces, and
// prover.test.js checks this function against that command's output rather than
// against a description of it.

const BN254_P = BigInt(
  '21888242871839275222246405745257275088696311157297823662689037894645226208583',
);

function toHex32(value) {
  const n = BigInt(value);
  if (n < 0n || n >= BN254_P) {
    throw new Error('field element out of range');
  }
  return `0x${n.toString(16).padStart(64, '0')}`;
}

// snarkjs emits pi_a as [x, y, 1]. The Solidity verifier takes [x, y] and does
// its own negation, so the Y coordinate is passed through untouched.
function encodeA(pi_a) {
  return [toHex32(pi_a[0]), toHex32(pi_a[1])];
}

// pi_b is a G2 point over Fp2: [[x0, x1], [y0, y1], [1, 0]]. Solidity's pairing
// precompile takes each Fp2 coefficient pair in reverse order, which is the
// order snarkjs already writes into its own calldata export — so the swap here
// is the one the verifier expects, not an extra one.
function encodeB(pi_b) {
  return [
    [toHex32(pi_b[0][1]), toHex32(pi_b[0][0])],
    [toHex32(pi_b[1][1]), toHex32(pi_b[1][0])],
  ];
}

function encodeC(pi_c) {
  return [toHex32(pi_c[0]), toHex32(pi_c[1])];
}

// The four arguments `verifyProof(uint[2] a, uint[2][2] b, uint[2] c, uint[N] input)`
// takes, as 32-byte hex strings. Callers pass them straight to a contract call.
export function encodeForSolidity(proof, publicSignals) {
  return {
    a: encodeA(proof.pi_a),
    b: encodeB(proof.pi_b),
    c: encodeC(proof.pi_c),
    input: publicSignals.map(toHex32),
  };
}
