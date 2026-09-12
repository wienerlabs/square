// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

interface IArbitration {
    enum Outcome {
        None,
        Complete,
        Reject,
        Lapsed
    }

    struct Dispute {
        address disputer;
        uint64 bond;
        uint48 disputedAt;
        uint48 resolveBy;
        uint32 setVersion;
        uint256 voted;
        Outcome outcome;
        uint16 providerBps;
        bytes32 resolutionHash;
        bool bondSettled;
    }

    event ArbitersUpdated(uint32 indexed version, address[] arbiters, uint8 threshold);
    event BondParametersUpdated(uint16 bondBps, uint64 minBond);
    event DisputeOpened(
        uint256 indexed jobId,
        address indexed disputer,
        uint64 bond,
        uint48 disputedAt,
        uint32 setVersion,
        uint48 resolveBy
    );
    event VoteCast(
        uint256 indexed jobId,
        address indexed arbiter,
        bytes32 indexed resolutionHash,
        uint8 outcome,
        uint16 providerBps,
        uint256 approvals
    );
    event DecisionReached(uint256 indexed jobId, uint8 outcome, uint16 providerBps, bytes32 resolutionHash);
    event DisputeExpired(uint256 indexed jobId);
    event BondSettled(uint256 indexed jobId, address indexed to, uint64 amount);
    event BondWithdrawn(address indexed account, address indexed to, uint256 amount);
    event RejectionNotApplied(uint256 indexed jobId, bytes reason);

    error ZeroAddress();
    error OnlyKeeperEvaluator();
    error NoArbiters();
    error BadArbiterSet();
    error BadBondParameters();
    error DisputeExists();
    error UnknownDispute();
    error AlreadyDecided();
    error NotAnArbiter();
    error AlreadyVoted();
    error BadResolution();
    error NotLapsed(uint48 resolveBy);
    error NothingToSettle();
    error InsufficientBalance();
    error SplitNeedsAPayoutResolver();
    error JobNoLongerVotable(uint8 status);

    function open(
        uint256 jobId,
        address disputer,
        uint64 budget,
        uint48 resolveBy,
        bytes32 evidence
    ) external returns (uint64 bond);
    function vote(uint256 jobId, Outcome outcome, uint16 providerBps) external;
    function lapse(uint256 jobId) external;
    function settleBond(uint256 jobId) external;
    function withdraw() external;
    function withdrawTo(address to, uint256 amount) external;

    function decision(uint256 jobId) external view returns (Outcome outcome, uint16 providerBps, bytes32 resolutionHash);
    function disputeOf(uint256 jobId) external view returns (Dispute memory);
    function approvalsOf(uint256 jobId, bytes32 resolutionHash) external view returns (uint256);
    function bondFor(uint64 budget) external view returns (uint64);
    function arbiterSet(uint32 version) external view returns (address[] memory arbiters, uint8 threshold);
    function currentVersion() external view returns (uint32);
    function withdrawable(address account) external view returns (uint256);
    function resolutionHash(uint256 jobId, Outcome outcome, uint16 providerBps) external pure returns (bytes32);
}
