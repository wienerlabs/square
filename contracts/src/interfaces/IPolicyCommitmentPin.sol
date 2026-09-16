// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

interface IPolicyCommitmentPin {
    function commitmentAtFund(uint256 jobId) external view returns (bytes32);
}
