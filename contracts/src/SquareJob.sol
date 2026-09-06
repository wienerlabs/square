// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {IACPHook} from "./interfaces/IACPHook.sol";
import {IPayoutResolver} from "./interfaces/IPayoutResolver.sol";
import {ISettlementHorizon} from "./interfaces/ISettlementHorizon.sol";
import {ISquareJob} from "./interfaces/ISquareJob.sol";

contract SquareJob is ISquareJob, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;
    using ERC165Checker for address;

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_TOTAL_FEE_BP = 2_000;

    IERC20 private immutable _paymentToken;
    uint256 private immutable _hookGasLimit;

    uint256 private _jobCounter;
    uint16 private _platformFeeBP;
    uint16 private _evaluatorFeeBP;
    address private _platformTreasury;
    uint256 private _totalWithdrawable;

    mapping(uint256 jobId => JobRecord) private _jobs;
    mapping(address hook => bool) private _whitelistedHooks;
    mapping(address account => uint256) private _withdrawable;

    constructor(
        address token,
        address treasury,
        uint16 platformFeeBP_,
        uint16 evaluatorFeeBP_,
        uint256 hookGasLimit_,
        address initialOwner
    ) Ownable(initialOwner) {
        if (token == address(0) || treasury == address(0)) revert ZeroAddress();
        if (uint256(platformFeeBP_) + evaluatorFeeBP_ > MAX_TOTAL_FEE_BP) revert FeesTooHigh();
        _paymentToken = IERC20(token);
        _hookGasLimit = hookGasLimit_;
        _platformFeeBP = platformFeeBP_;
        _evaluatorFeeBP = evaluatorFeeBP_;
        _platformTreasury = treasury;
        _whitelistedHooks[address(0)] = true;
        emit HookWhitelistUpdated(address(0), true);
        emit FeesUpdated(platformFeeBP_, evaluatorFeeBP_, treasury);
    }

    function setFees(uint16 platformFeeBP_, uint16 evaluatorFeeBP_, address treasury) external onlyOwner {
        if (treasury == address(0)) revert ZeroAddress();
        if (uint256(platformFeeBP_) + evaluatorFeeBP_ > MAX_TOTAL_FEE_BP) revert FeesTooHigh();
        _platformFeeBP = platformFeeBP_;
        _evaluatorFeeBP = evaluatorFeeBP_;
        _platformTreasury = treasury;
        emit FeesUpdated(platformFeeBP_, evaluatorFeeBP_, treasury);
    }

    function setHookWhitelist(address hook, bool allowed) external onlyOwner {
        _whitelistedHooks[hook] = allowed;
        emit HookWhitelistUpdated(hook, allowed);
    }

    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external nonReentrant returns (uint256 jobId) {
        if (evaluator == address(0)) revert ZeroAddress();
        if (expiredAt <= block.timestamp) revert ExpiryInPast();
        if (expiredAt > type(uint48).max) revert ExpiryTooLarge();
        if (!_whitelistedHooks[hook]) revert HookNotWhitelisted(hook);
        bool resolvesPayout;
        if (hook != address(0)) {
            if (!hook.supportsInterface(type(IACPHook).interfaceId)) revert InvalidHook(hook);
            resolvesPayout = hook.supportsInterface(type(IPayoutResolver).interfaceId);
        }
        uint256 earliest = block.timestamp + _settlementHorizon(evaluator);
        if (expiredAt < earliest) revert ExpiryTooShort(earliest);

        jobId = ++_jobCounter;
        JobRecord storage job = _jobs[jobId];
        job.client = msg.sender;
        job.createdAt = uint48(block.timestamp);
        job.expiredAt = uint48(expiredAt);
        job.provider = provider;
        job.evaluator = evaluator;
        job.hook = hook;
        job.hookResolvesPayout = resolvesPayout;
        job.description = description;

        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt, hook);
        emit JobDescribed(jobId, uint48(block.timestamp), description);
    }

    function setProvider(uint256 jobId, address provider, bytes calldata optParams) external nonReentrant {
        JobRecord storage job = _existing(jobId);
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.client) revert Unauthorized();
        if (job.provider != address(0)) revert ProviderAlreadySet();
        if (provider == address(0)) revert ZeroAddress();

        bytes memory data = abi.encode(provider, optParams);
        _beforeHook(job.hook, jobId, data);
        job.provider = provider;
        emit ProviderSet(jobId, provider);
        _afterHook(job.hook, jobId, data);
    }

    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external nonReentrant {
        JobRecord storage job = _existing(jobId);
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.client && msg.sender != job.provider) revert Unauthorized();
        if (amount > type(uint64).max) revert BudgetTooLarge();

        bytes memory data = abi.encode(amount, optParams);
        _beforeHook(job.hook, jobId, data);
        job.budget = uint64(amount);
        emit BudgetSet(jobId, amount);
        _afterHook(job.hook, jobId, data);
    }

    function fund(uint256 jobId, uint256 expectedBudget, bytes calldata optParams) external nonReentrant {
        JobRecord storage job = _existing(jobId);
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.client) revert Unauthorized();
        if (job.provider == address(0)) revert ProviderNotSet();
        uint256 amount = job.budget;
        if (amount == 0) revert ZeroBudget();
        if (amount != expectedBudget) revert BudgetMismatch();
        if (block.timestamp >= job.expiredAt) revert PastExpiry();

        _beforeHook(job.hook, jobId, optParams);
        job.status = JobStatus.Funded;
        job.fundedAt = uint48(block.timestamp);
        job.platformFeeBP = _platformFeeBP;
        job.evaluatorFeeBP = _evaluatorFeeBP;
        emit JobFunded(jobId, msg.sender, amount);
        emit FeesSnapshotted(jobId, _platformFeeBP, _evaluatorFeeBP, uint48(block.timestamp));
        _paymentToken.safeTransferFrom(msg.sender, address(this), amount);
        _afterHook(job.hook, jobId, optParams);
    }

    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external nonReentrant {
        JobRecord storage job = _existing(jobId);
        if (job.status != JobStatus.Funded) revert WrongStatus();
        if (msg.sender != job.provider) revert Unauthorized();
        if (block.timestamp >= job.expiredAt) revert PastExpiry();
        uint256 earliest = block.timestamp + _settlementHorizon(job.evaluator);
        if (job.expiredAt < earliest) revert ExpiryTooShort(earliest);

        bytes memory data = abi.encode(deliverable, optParams);
        _beforeHook(job.hook, jobId, data);
        job.status = JobStatus.Submitted;
        job.submittedAt = uint48(block.timestamp);
        job.deliverable = deliverable;
        emit JobSubmitted(jobId, msg.sender, deliverable);
        emit SubmissionTimed(jobId, uint48(block.timestamp), job.expiredAt);
        _afterHook(job.hook, jobId, data);
    }

    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external nonReentrant {
        JobRecord storage job = _existing(jobId);
        if (job.status != JobStatus.Submitted) revert WrongStatus();
        if (msg.sender != job.evaluator) revert Unauthorized();

        bytes memory data = abi.encode(reason, optParams);
        (address payee, uint16 providerBps) = _resolvePayout(job, jobId, data);
        _beforeHook(job.hook, jobId, data);

        job.status = JobStatus.Completed;
        job.payee = payee;
        job.providerBps = providerBps;

        uint256 amount = job.budget;
        uint256 platformFee = (amount * job.platformFeeBP) / BPS;
        uint256 evaluatorFee = (amount * job.evaluatorFeeBP) / BPS;
        uint256 net = amount - platformFee - evaluatorFee;
        uint256 providerShare = (net * providerBps) / BPS;
        uint256 clientShare = net - providerShare;

        if (platformFee > 0) {
            _credit(_platformTreasury, platformFee);
            emit PlatformFeeAccrued(jobId, _platformTreasury, platformFee);
        }
        if (evaluatorFee > 0) {
            _credit(job.evaluator, evaluatorFee);
            emit EvaluatorFeePaid(jobId, job.evaluator, evaluatorFee);
        }
        if (providerShare > 0) _credit(payee, providerShare);
        emit PaymentReleased(jobId, payee, providerShare);
        if (clientShare > 0) {
            _credit(job.client, clientShare);
            emit Refunded(jobId, job.client, clientShare);
        }
        emit PayoutRouted(jobId, payee, providerBps, providerShare, clientShare);
        emit JobCompleted(jobId, msg.sender, reason);

        _afterHook(job.hook, jobId, data);
    }

    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external nonReentrant {
        JobRecord storage job = _existing(jobId);
        JobStatus previous = job.status;
        if (previous == JobStatus.Open) {
            if (msg.sender != job.client) revert Unauthorized();
        } else if (previous == JobStatus.Funded || previous == JobStatus.Submitted) {
            if (msg.sender != job.evaluator) revert Unauthorized();
        } else {
            revert WrongStatus();
        }

        bytes memory data = abi.encode(reason, optParams);
        _beforeHook(job.hook, jobId, data);
        job.status = JobStatus.Rejected;
        if (previous != JobStatus.Open) {
            uint256 amount = job.budget;
            _credit(job.client, amount);
            emit Refunded(jobId, job.client, amount);
        }
        emit JobRejected(jobId, msg.sender, reason);
        _afterHook(job.hook, jobId, data);
    }

    function claimRefund(uint256 jobId) external nonReentrant {
        JobRecord storage job = _existing(jobId);
        if (job.status != JobStatus.Funded && job.status != JobStatus.Submitted) revert WrongStatus();
        if (block.timestamp < job.expiredAt) revert NotExpired();

        job.status = JobStatus.Expired;
        uint256 amount = job.budget;
        _credit(job.client, amount);
        emit Refunded(jobId, job.client, amount);
        emit JobExpired(jobId);
    }

    function withdraw() external {
        withdrawTo(msg.sender, _withdrawable[msg.sender]);
    }

    function withdrawTo(address to, uint256 amount) public nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = _withdrawable[msg.sender];
        if (amount > balance) revert InsufficientBalance();
        _withdrawable[msg.sender] = balance - amount;
        _totalWithdrawable -= amount;
        emit Withdrawn(msg.sender, to, amount);
        _paymentToken.safeTransfer(to, amount);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        JobRecord storage job = _existing(jobId);
        return Job({
            id: jobId,
            client: job.client,
            provider: job.provider,
            evaluator: job.evaluator,
            description: job.description,
            budget: job.budget,
            expiredAt: job.expiredAt,
            status: job.status,
            hook: job.hook
        });
    }

    function getJobRecord(uint256 jobId) external view returns (JobRecord memory) {
        return _existing(jobId);
    }

    function netPayout(uint256 jobId) public view returns (uint256) {
        JobRecord storage job = _existing(jobId);
        uint256 amount = job.budget;
        (uint16 platformBP, uint16 evaluatorBP) = job.status == JobStatus.Open
            ? (_platformFeeBP, _evaluatorFeeBP)
            : (job.platformFeeBP, job.evaluatorFeeBP);
        return amount - (amount * platformBP) / BPS - (amount * evaluatorBP) / BPS;
    }

    function withdrawable(address account) external view returns (uint256) {
        return _withdrawable[account];
    }

    function totalWithdrawable() external view returns (uint256) {
        return _totalWithdrawable;
    }

    function jobCounter() external view returns (uint256) {
        return _jobCounter;
    }

    function whitelistedHooks(address hook) external view returns (bool) {
        return _whitelistedHooks[hook];
    }

    function paymentToken() external view returns (address) {
        return address(_paymentToken);
    }

    function hookGasLimit() external view returns (uint256) {
        return _hookGasLimit;
    }

    function platformFeeBP() external view returns (uint16) {
        return _platformFeeBP;
    }

    function evaluatorFeeBP() external view returns (uint16) {
        return _evaluatorFeeBP;
    }

    function platformTreasury() external view returns (address) {
        return _platformTreasury;
    }

    function _existing(uint256 jobId) private view returns (JobRecord storage job) {
        job = _jobs[jobId];
        if (job.createdAt == 0) revert InvalidJob();
    }

    function _credit(address account, uint256 amount) private {
        _withdrawable[account] += amount;
        _totalWithdrawable += amount;
    }

    function _settlementHorizon(address evaluator) private view returns (uint48) {
        if (!evaluator.supportsInterface(type(ISettlementHorizon).interfaceId)) return 0;
        return ISettlementHorizon(evaluator).settlementHorizon();
    }

    function _resolvePayout(JobRecord storage job, uint256 jobId, bytes memory data)
        private
        view
        returns (address payee, uint16 providerBps)
    {
        if (!job.hookResolvesPayout) return (job.provider, uint16(BPS));
        (payee, providerBps) = IPayoutResolver(job.hook).resolvePayout{gas: _hookGasLimit}(jobId, data);
        if (payee == address(0)) revert InvalidPayee();
        if (providerBps > BPS) revert InvalidSplit();
    }

    function _beforeHook(address hook, uint256 jobId, bytes memory data) private {
        if (hook == address(0)) return;
        _callHook(hook, abi.encodeCall(IACPHook.beforeAction, (jobId, msg.sig, data)));
    }

    function _afterHook(address hook, uint256 jobId, bytes memory data) private {
        if (hook == address(0)) return;
        _callHook(hook, abi.encodeCall(IACPHook.afterAction, (jobId, msg.sig, data)));
    }

    function _callHook(address hook, bytes memory callData) private {
        (bool ok, bytes memory ret) = hook.call{gas: _hookGasLimit}(callData);
        if (ok) return;
        if (ret.length == 0) revert HookReverted(hook);
        assembly ("memory-safe") {
            revert(add(ret, 32), mload(ret))
        }
    }
}
