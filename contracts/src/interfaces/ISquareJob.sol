// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

interface ISquareJob {
    enum JobStatus {
        Open,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    struct Job {
        uint256 id;
        address client;
        address provider;
        address evaluator;
        string description;
        uint256 budget;
        uint256 expiredAt;
        JobStatus status;
        address hook;
    }

    struct JobRecord {
        address client;
        uint48 createdAt;
        uint48 expiredAt;
        address provider;
        uint48 fundedAt;
        uint48 submittedAt;
        address evaluator;
        uint64 budget;
        JobStatus status;
        address hook;
        uint16 platformFeeBP;
        uint16 evaluatorFeeBP;
        uint16 providerBps;
        bool hookResolvesPayout;
        address payee;
        bytes32 deliverable;
        string description;
    }

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed provider,
        address evaluator,
        uint256 expiredAt,
        address hook
    );
    event ProviderSet(uint256 indexed jobId, address indexed provider);
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event EvaluatorFeePaid(uint256 indexed jobId, address indexed evaluator, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event HookWhitelistUpdated(address indexed hook, bool status);

    event JobDescribed(uint256 indexed jobId, uint48 createdAt, string description);
    event FeesSnapshotted(uint256 indexed jobId, uint16 platformFeeBP, uint16 evaluatorFeeBP, uint48 fundedAt);
    event SubmissionTimed(uint256 indexed jobId, uint48 submittedAt, uint48 expiredAt);
    event PayoutRouted(
        uint256 indexed jobId,
        address indexed payee,
        uint16 providerBps,
        uint256 providerShare,
        uint256 clientShare
    );
    event PlatformFeeAccrued(uint256 indexed jobId, address indexed treasury, uint256 amount);
    event Withdrawn(address indexed account, address indexed to, uint256 amount);
    event FeesUpdated(uint16 platformFeeBP, uint16 evaluatorFeeBP, address treasury);

    error InvalidJob();
    error WrongStatus();
    error Unauthorized();
    error ZeroAddress();
    error ExpiryInPast();
    error ExpiryTooLarge();
    error ExpiryTooShort(uint256 earliestAllowed);
    error PastExpiry();
    error NotExpired();
    error ZeroBudget();
    error BudgetTooLarge();
    error BudgetMismatch();
    error ProviderNotSet();
    error ProviderAlreadySet();
    error FeesTooHigh();
    error HookNotWhitelisted(address hook);
    error InvalidHook(address hook);
    error HookReverted(address hook);
    error InvalidPayee();
    error InvalidSplit();
    error InsufficientBalance();

    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external returns (uint256 jobId);
    function setProvider(uint256 jobId, address provider, bytes calldata optParams) external;
    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external;
    function fund(uint256 jobId, uint256 expectedBudget, bytes calldata optParams) external;
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external;
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function claimRefund(uint256 jobId) external;

    function withdraw() external;
    function withdrawTo(address to, uint256 amount) external;

    function getJob(uint256 jobId) external view returns (Job memory);
    function getJobRecord(uint256 jobId) external view returns (JobRecord memory);
    function netPayout(uint256 jobId) external view returns (uint256);
    function withdrawable(address account) external view returns (uint256);
    function totalWithdrawable() external view returns (uint256);
    function jobCounter() external view returns (uint256);
    function whitelistedHooks(address hook) external view returns (bool);
    function paymentToken() external view returns (address);
    function hookGasLimit() external view returns (uint256);
    function platformFeeBP() external view returns (uint16);
    function evaluatorFeeBP() external view returns (uint16);
    function platformTreasury() external view returns (address);
}
