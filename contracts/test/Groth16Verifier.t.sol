// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Groth16Verifier} from "../src/Groth16Verifier.sol";

/// @notice The verifier against proofs the prover service actually produced.
///
/// The fixtures in test/fixtures/proofs.json are not hand-written. They are the
/// `solidity` field of a real `POST /prove` response, generated from the real
/// circuit and the real proving key — see script/regenerate-fixtures.sh. A
/// verifier tested against proofs invented for the test proves that the test
/// and the test's author agree, which is not the property anyone needs.
///
/// What matters here is the pairing, not the policy. `is_compliant` is one of
/// the eight public signals; a non-compliant payment still produces a valid
/// proof, and refusing to release on it is the hook's job (#27). So this
/// contract accepts the blocked-recipient proof too, and the test says so
/// explicitly rather than leaving it looking like an oversight.
contract Groth16VerifierTest is Test {
    using stdJson for string;

    Groth16Verifier internal verifier;
    string internal fixtures;

    function setUp() public {
        verifier = new Groth16Verifier();
        fixtures = vm.readFile("test/fixtures/proofs.json");
    }

    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
        uint256[8] input;
    }

    function _load(string memory key) internal view returns (Proof memory p) {
        uint256[] memory a = fixtures.readUintArray(string.concat(key, ".a"));
        uint256[] memory c = fixtures.readUintArray(string.concat(key, ".c"));
        uint256[] memory b0 = fixtures.readUintArray(string.concat(key, ".b[0]"));
        uint256[] memory b1 = fixtures.readUintArray(string.concat(key, ".b[1]"));
        uint256[] memory input = fixtures.readUintArray(string.concat(key, ".input"));

        p.a = [a[0], a[1]];
        p.b = [[b0[0], b0[1]], [b1[0], b1[1]]];
        p.c = [c[0], c[1]];
        for (uint256 i = 0; i < 8; i++) {
            p.input[i] = input[i];
        }
    }

    /// A proof the prover service produced verifies on chain.
    function test_acceptsRealProofFromTheProverService() public view {
        Proof memory p = _load(".compliant");
        assertTrue(verifier.verifyProof(p.a, p.b, p.c, p.input));
    }

    /// is_compliant is a public signal, not a precondition for verification.
    function test_acceptsANonCompliantProof() public view {
        Proof memory p = _load(".blocked");
        assertEq(p.input[0], 0, "fixture should be the non-compliant one");
        assertTrue(
            verifier.verifyProof(p.a, p.b, p.c, p.input),
            "the circuit proves the check ran, not that it passed"
        );
    }

    /// The eight public signals are in the order the circuit declares them.
    function test_publicSignalLayout() public view {
        Proof memory ok = _load(".compliant");
        assertEq(ok.input[0], 1, "is_compliant");
        assertEq(ok.input[2], uint256(uint160(0x1111111111111111111111111111111111111111)), "recipient");
        assertEq(ok.input[3], 5_000_000, "amount, USDC base units");
        assertEq(ok.input[4], uint256(uint160(0x3600000000000000000000000000000000000000)), "token");
        assertEq(ok.input[5], 50_000_000, "daily_spent_before");
        assertEq(ok.input[6], 1_788_356_730, "current_unix_timestamp");
        assertEq(ok.input[7], 0, "stripe_receipt_hash");
    }

    /// Flipping is_compliant is the attack the whole thing has to stop.
    function test_rejectsAFlippedComplianceBit() public view {
        Proof memory p = _load(".blocked");
        p.input[0] = 1;
        assertFalse(verifier.verifyProof(p.a, p.b, p.c, p.input));
    }

    /// So is redirecting the payment to a different recipient.
    function test_rejectsASubstitutedRecipient() public view {
        Proof memory p = _load(".compliant");
        p.input[2] = uint256(uint160(0x000000000000000000000000000000000000dEaD));
        assertFalse(verifier.verifyProof(p.a, p.b, p.c, p.input));
    }

    function test_rejectsAnAlteredAmount() public view {
        Proof memory p = _load(".compliant");
        p.input[3] = 5_000_001;
        assertFalse(verifier.verifyProof(p.a, p.b, p.c, p.input));
    }

    function test_rejectsATamperedProofPoint() public view {
        Proof memory p = _load(".compliant");
        unchecked {
            p.a[0] = p.a[0] + 1;
        }
        assertFalse(verifier.verifyProof(p.a, p.b, p.c, p.input));
    }

    /// A point outside the field is rejected rather than reverting the caller.
    function test_rejectsAnOutOfFieldValue() public view {
        Proof memory p = _load(".compliant");
        p.input[3] = type(uint256).max;
        assertFalse(verifier.verifyProof(p.a, p.b, p.c, p.input));
    }

    /// Gas, measured rather than estimated.
    ///
    /// `forge test --gas-report` folds a `view` call into the test's own total,
    /// which here includes parsing the JSON fixture and is meaningless. This
    /// brackets the call itself with `gasleft()`, so the number is the
    /// execution cost of the pairing check and nothing else. The calldata a
    /// real transaction pays for is reported separately below, because on-chain
    /// cost is the sum of the two and quoting only one of them understates it.
    function test_gas_verifyProof() public view {
        Proof memory p = _load(".compliant");

        uint256 before = gasleft();
        bool ok = verifier.verifyProof(p.a, p.b, p.c, p.input);
        uint256 execution = before - gasleft();

        assertTrue(ok);

        // 8 proof words + 8 public signals, ABI-encoded with a 4-byte selector.
        bytes memory callData =
            abi.encodeCall(Groth16Verifier.verifyProof, (p.a, p.b, p.c, p.input));
        uint256 calldataGas = 0;
        for (uint256 i = 0; i < callData.length; i++) {
            calldataGas += callData[i] == 0 ? 4 : 16;
        }

        console.log("verifyProof execution gas:", execution);
        console.log("calldata gas:            ", calldataGas);
        console.log("21000 base + both:       ", 21000 + execution + calldataGas);
    }
}
