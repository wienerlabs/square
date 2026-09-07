// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

interface IComplianceModule {
    function checkRelease(
        uint256 jobId,
        address payee,
        uint256 amount,
        address token,
        address client,
        bytes calldata proof
    ) external returns (bool verified);
}
