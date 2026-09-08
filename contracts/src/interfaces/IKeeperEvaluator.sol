// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ISettlementHorizon} from "./ISettlementHorizon.sol";

interface IKeeperEvaluator is ISettlementHorizon {
    struct Window {
        uint48 effectiveFrom;
        uint48 challengeWindow;
        uint48 disputeWindow;
    }

    struct DisputeRef {
        address disputer;
        uint48 disputedAt;
        bool resolved;
    }

    event WindowsConfigured(uint48 effectiveFrom, uint48 challengeWindow, uint48 disputeWindow);
    event FinalizeGraceConfigured(uint48 finalizeGrace);
    event ArbitrationSet(address indexed arbitration);
    event Finalized(uint256 indexed jobId, address indexed keeper, uint256 keeperFee);
    event DisputeRaised(uint256 indexed jobId, address indexed disputer, uint48 disputedAt, uint48 challengeEnd);
    event DecisionApplied(
        uint256 indexed jobId, uint8 outcome, uint16 providerBps, address indexed keeper, uint256 keeperFee
    );

    error ZeroAddress();
    error ZeroWindow();
    error NotOurJob();
    error NotSubmitted();
    error WindowOpen(uint48 challengeEnd);
    error WindowClosed(uint48 challengeEnd);
    error Disputed();
    error NotDisputed();
    error AlreadyResolved();
    error NotDecided();
    error OnlyClient();
    error OnlyArbitration();
    error ArbitrationAlreadySet();
    error ArbitrationNotSet();

    function finalize(uint256 jobId, bytes calldata complianceProof) external;
    function dispute(uint256 jobId, bytes32 evidence) external;
    function finalizeDecided(uint256 jobId, bytes calldata complianceProof) external;
    function applyRejection(uint256 jobId, bytes32 resolutionHash) external;

    function squareJob() external view returns (address);
    function arbitration() external view returns (address);
    function challengeEndsAt(uint256 jobId) external view returns (uint48);
    function windowFor(uint48 submittedAt) external view returns (Window memory);
    function currentWindow() external view returns (Window memory);
    function finalizeGrace() external view returns (uint48);
    function disputeOf(uint256 jobId) external view returns (DisputeRef memory);
    function isDisputed(uint256 jobId) external view returns (bool);
    function finalizeReason(uint256 jobId, bytes32 deliverable) external pure returns (bytes32);
}
