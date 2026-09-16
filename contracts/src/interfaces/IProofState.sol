// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IComplianceModule} from "./IComplianceModule.sol";

interface IProofState {
    function proofState(uint256 jobId) external view returns (IComplianceModule.ProofState);
}
