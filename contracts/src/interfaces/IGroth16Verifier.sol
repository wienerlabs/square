// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

// The BN254 scalar field, the range every public signal lives in.
//
// `Groth16Verifier.verifyProof` refuses an input at or above this before it
// touches a precompile, and `payment.circom` emits Poseidon outputs and field
// elements, which are always below it. So a value at or above `r` is not a
// signal any proof can carry — it is a number outside the system.
//
// Declared here, at file level, because two contracts have to agree on it: the
// verifier enforcing it on the way in, and `PolicyRegistry` refusing to store a
// policy commitment no proof could ever match (#231). Two copies of a 78-digit
// constant is a way for them to drift.
uint256 constant SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

/// @title The payment-compliance verifying key, as a contract
/// @notice `Groth16Verifier` keyed to one build of `circuits/payment.circom`.
///
/// Stateless and `view`. It answers "is this a valid proof for these eight
/// public signals under this key", and nothing else — in particular it verifies
/// a proof carrying `is_compliant = 0` just as happily, because the circuit
/// proves that the six checks *ran*, not that they passed. Reading signal 0 and
/// deciding what to do about it belongs to the compliance module.
///
/// The eight signals, in the order the circuit emits them
/// (`circuits/payment.circom:154-161`):
///
/// | # | Signal |
/// |---|---|
/// | 0 | `is_compliant` |
/// | 1 | `policy_data_hash` |
/// | 2 | `recipient` |
/// | 3 | `amount` |
/// | 4 | `token` |
/// | 5 | `daily_spent_before` |
/// | 6 | `current_unix_timestamp` |
/// | 7 | `stripe_receipt_hash` |
interface IGroth16Verifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[8] calldata input
    ) external view returns (bool);
}
