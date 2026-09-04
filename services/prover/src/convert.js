// BN254 base field prime p (matches the scalar field used by alt_bn128 on
// Solana). Required for negating the Y coordinate of proof_a per the
// groth16-solana verifier convention.
const BN254_P = BigInt(
  '21888242871839275222246405745257275088696311157297823662689037894645226208583',
);

// Serialize a decimal string into a 32-byte big-endian Buffer.
function toFieldBytes(decimalString) {
  const n = BigInt(decimalString);
  if (n < 0n || n >= BN254_P) {
    throw new Error(`Field element out of range: ${decimalString}`);
  }
  let hex = n.toString(16);
  if (hex.length % 2 === 1) hex = '0' + hex;
  const buf = Buffer.alloc(32);
  Buffer.from(hex, 'hex').copy(buf, 32 - hex.length / 2);
  return buf;
}

// snarkjs emits proof_a as [x, y, 1] with decimal strings. groth16-solana
// expects 64 bytes = x || negate(y), each 32 bytes big-endian. Negation flips
// the pairing direction so the final equation holds without sign inversion on
// the verifier side.
function encodeProofA(pi_a) {
  const x = BigInt(pi_a[0]);
  const y = BigInt(pi_a[1]);
  const negY = (BN254_P - y) % BN254_P;

  const xBytes = toFieldBytes(x.toString());
  const yBytes = toFieldBytes(negY.toString());

  return Buffer.concat([xBytes, yBytes]);
}

// snarkjs emits proof_b as [[x0, x1], [y0, y1], [1, 0]] for a G2 element over
// Fp2. groth16-solana expects 128 bytes = x1 || x0 || y1 || y0 (the Fp2
// components are reversed compared to snarkjs's output order so the byte
// layout matches the Rust arkworks representation).
function encodeProofB(pi_b) {
  const x0 = BigInt(pi_b[0][0]);
  const x1 = BigInt(pi_b[0][1]);
  const y0 = BigInt(pi_b[1][0]);
  const y1 = BigInt(pi_b[1][1]);

  return Buffer.concat([
    toFieldBytes(x1.toString()),
    toFieldBytes(x0.toString()),
    toFieldBytes(y1.toString()),
    toFieldBytes(y0.toString()),
  ]);
}

// snarkjs emits proof_c as [x, y, 1]. groth16-solana expects 64 bytes = x || y.
function encodeProofC(pi_c) {
  return Buffer.concat([
    toFieldBytes(pi_c[0]),
    toFieldBytes(pi_c[1]),
  ]);
}

// Convert each public input (decimal string) to a 32-byte big-endian buffer,
// matching the format groth16-solana expects for its public inputs slice.
function encodePublicInputs(publicInputs) {
  return publicInputs.map((input) => toFieldBytes(input));
}

// Shape the snarkjs (proof, public) pair into the exact Buffers that the
// Solana verifier instruction takes as arguments. Everything is returned as
// base64-encoded strings so the HTTP response stays JSON-clean; the Solana
// client decodes before calling the program.
export function encodeForGroth16Solana(proof, publicInputs) {
  const proofA = encodeProofA(proof.pi_a);
  const proofB = encodeProofB(proof.pi_b);
  const proofC = encodeProofC(proof.pi_c);
  const publics = encodePublicInputs(publicInputs);

  return {
    proof_a: proofA.toString('base64'),
    proof_b: proofB.toString('base64'),
    proof_c: proofC.toString('base64'),
    public_inputs: publics.map((buf) => buf.toString('base64')),
  };
}
