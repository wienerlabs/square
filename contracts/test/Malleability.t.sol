// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test, stdJson} from "forge-std/Test.sol";
import {Groth16Verifier} from "../src/Groth16Verifier.sol";

/// Is a Groth16 proof re-randomisable against *this* verifier?
///
/// The claim is standard -- for a valid (A, B, C) and random r, s,
/// (rA, r⁻¹B + sδ, C + rsA) verifies for the same public signals -- but a claim
/// about a verifier is worth measuring against the verifier.
contract MalleabilityTest is Test {
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

    function _load(string memory json, string memory key) internal pure returns (Proof memory p) {
        uint256[] memory a = json.readUintArray(string.concat(key, ".a"));
        uint256[] memory c = json.readUintArray(string.concat(key, ".c"));
        uint256[] memory b0 = json.readUintArray(string.concat(key, ".b[0]"));
        uint256[] memory b1 = json.readUintArray(string.concat(key, ".b[1]"));
        uint256[] memory input = json.readUintArray(string.concat(key, ".input"));
        p.a = [a[0], a[1]];
        p.b = [[b0[0], b0[1]], [b1[0], b1[1]]];
        p.c = [c[0], c[1]];
        for (uint256 i = 0; i < 8; i++) p.input[i] = input[i];
    }

    function test_theOriginalVerifies() public view {
        Proof memory p = _load(fixtures, ".compliant");
        assertTrue(verifier.verifyProof(p.a, p.b, p.c, p.input));
    }

    function test_aRerandomisedProofAlsoVerifies() public view {
        Proof memory original = _load(fixtures, ".compliant");
        Proof memory copy = _load(fixtures, ".compliant_rerandomised");

        assertEq(keccak256(abi.encode(copy.input)), keccak256(abi.encode(original.input)), "same statement");
        assertTrue(
            keccak256(abi.encode(copy.a, copy.b, copy.c)) != keccak256(abi.encode(original.a, original.b, original.c)),
            "different bytes"
        );
        assertTrue(verifier.verifyProof(copy.a, copy.b, copy.c, copy.input), "the verifier accepts the copy");
    }
}
