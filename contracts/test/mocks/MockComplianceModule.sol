// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IComplianceModule} from "../../src/interfaces/IComplianceModule.sol";

contract MockComplianceModule is IComplianceModule {
    struct Check {
        uint256 jobId;
        address payee;
        uint256 amount;
        address token;
        address client;
        bytes proof;
    }

    Check[] public checks;
    bool public rejectAll;
    bool public refuseAll;
    bytes32 public expectedProof;
    uint256 public gasToBurn;

    error ReleaseNotCompliant(uint256 jobId, address payee, uint256 amount);

    function setRejectAll(bool value) external {
        rejectAll = value;
    }

    function setRefuseAll(bool value) external {
        refuseAll = value;
    }

    function setExpectedProof(bytes32 value) external {
        expectedProof = value;
    }

    function setGasToBurn(uint256 value) external {
        gasToBurn = value;
    }

    /// @dev The preview a real module answers from the same state. This mock has
    ///      no state to speak of, so it mirrors the flags: rejectAll and a proof
    ///      that does not match make it false, and it never reverts, which is the
    ///      contract SquareHook.resolvePayout relies on.
    function previewRelease(
        uint256,
        address,
        uint256,
        address,
        address,
        bytes calldata proof
    ) external view returns (bool) {
        if (rejectAll) return false;
        if (expectedProof != bytes32(0) && keccak256(proof) != expectedProof) return false;
        return true;
    }

    function checkRelease(
        uint256 jobId,
        address payee,
        uint256 amount,
        address token,
        address client,
        bytes calldata proof
    ) external returns (bool) {
        if (gasToBurn > 0) {
            uint256 start = gasleft();
            uint256 x;
            while (start - gasleft() < gasToBurn) x = uint256(keccak256(abi.encode(x)));
        }
        if (rejectAll) revert ReleaseNotCompliant(jobId, payee, amount);
        checks.push(Check(jobId, payee, amount, token, client, proof));
        if (refuseAll) return false;
        if (expectedProof != bytes32(0) && keccak256(proof) != expectedProof) return false;
        return true;
    }

    function checkCount() external view returns (uint256) {
        return checks.length;
    }

    function lastCheck() external view returns (Check memory) {
        return checks[checks.length - 1];
    }
}
