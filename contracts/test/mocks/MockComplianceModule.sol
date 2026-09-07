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
    bytes32 public expectedProof;
    uint256 public gasToBurn;

    error ReleaseNotCompliant(uint256 jobId, address payee, uint256 amount);

    function setRejectAll(bool value) external {
        rejectAll = value;
    }

    function setExpectedProof(bytes32 value) external {
        expectedProof = value;
    }

    function setGasToBurn(uint256 value) external {
        gasToBurn = value;
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
        if (expectedProof != bytes32(0) && keccak256(proof) != expectedProof) {
            revert ReleaseNotCompliant(jobId, payee, amount);
        }
        checks.push(Check(jobId, payee, amount, token, client, proof));
        return true;
    }

    function checkCount() external view returns (uint256) {
        return checks.length;
    }

    function lastCheck() external view returns (Check memory) {
        return checks[checks.length - 1];
    }
}
