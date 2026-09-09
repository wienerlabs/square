// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISquareJob} from "./interfaces/ISquareJob.sol";
import {IKeeperEvaluator} from "./interfaces/IKeeperEvaluator.sol";
import {ISettlementHorizon} from "./interfaces/ISettlementHorizon.sol";
import {IArbitration} from "./interfaces/IArbitration.sol";

contract KeeperEvaluator is IKeeperEvaluator, ERC165, Ownable2Step, ReentrancyGuard {
    uint16 private constant FULL_BPS = 10_000;

    ISquareJob private immutable _squareJob;
    IArbitration private _arbitration;
    Window[] private _windows;
    mapping(uint256 jobId => DisputeRef) private _disputes;

    modifier onlyArbitration() {
        if (msg.sender != address(_arbitration) || msg.sender == address(0)) revert OnlyArbitration();
        _;
    }

    constructor(
        address squareJob_,
        address initialOwner,
        uint48 challengeWindow,
        uint48 disputeWindow,
        uint48 finalizeGrace_
    ) Ownable(initialOwner) {
        if (squareJob_ == address(0)) revert ZeroAddress();
        _squareJob = ISquareJob(squareJob_);
        _pushWindow(0, challengeWindow, disputeWindow, finalizeGrace_);
    }

    function configureWindows(uint48 challengeWindow, uint48 disputeWindow) external onlyOwner {
        _pushWindow(uint48(block.timestamp), challengeWindow, disputeWindow, _current().finalizeGrace);
    }

    function setFinalizeGrace(uint48 finalizeGrace_) external onlyOwner {
        Window storage window = _current();
        _pushWindow(uint48(block.timestamp), window.challengeWindow, window.disputeWindow, finalizeGrace_);
    }

    function setArbitration(address arbitration_) external onlyOwner {
        if (arbitration_ == address(0)) revert ZeroAddress();
        if (address(_arbitration) != address(0)) revert ArbitrationAlreadySet();
        _arbitration = IArbitration(arbitration_);
        emit ArbitrationSet(arbitration_);
    }

    function finalize(uint256 jobId, bytes calldata complianceProof) external nonReentrant {
        ISquareJob.JobRecord memory job = _submittedJob(jobId);
        if (_disputes[jobId].disputedAt != 0) revert Disputed();
        uint48 end = job.submittedAt + windowFor(job.submittedAt).challengeWindow;
        if (block.timestamp < end) revert WindowOpen(end);

        _squareJob.complete(jobId, finalizeReason(jobId, job.deliverable), abi.encode(FULL_BPS, complianceProof));
        uint256 fee = _forwardFee();
        emit Finalized(jobId, msg.sender, fee);
    }

    function dispute(uint256 jobId, bytes32 evidence) external nonReentrant {
        ISquareJob.JobRecord memory job = _submittedJob(jobId);
        if (msg.sender != job.client) revert OnlyClient();
        if (_disputes[jobId].disputedAt != 0) revert Disputed();
        if (address(_arbitration) == address(0)) revert ArbitrationNotSet();
        Window memory window = windowFor(job.submittedAt);
        uint48 end = job.submittedAt + window.challengeWindow;
        if (block.timestamp >= end) revert WindowClosed(end);

        uint48 now48 = uint48(block.timestamp);
        _disputes[jobId] = DisputeRef({disputer: msg.sender, disputedAt: now48, resolved: false});
        emit DisputeRaised(jobId, msg.sender, now48, end);
        _arbitration.open(jobId, msg.sender, job.budget, now48 + window.disputeWindow, evidence);
    }

    function applyRejection(uint256 jobId, bytes32 resolutionHash) external onlyArbitration {
        DisputeRef storage ref = _disputes[jobId];
        if (ref.disputedAt == 0) revert NotDisputed();
        if (ref.resolved) revert AlreadyResolved();
        ref.resolved = true;
        _squareJob.reject(jobId, resolutionHash, "");
        emit DecisionApplied(jobId, uint8(IArbitration.Outcome.Reject), 0, msg.sender, 0);
    }

    function finalizeDecided(uint256 jobId, bytes calldata complianceProof) external nonReentrant {
        DisputeRef storage ref = _disputes[jobId];
        if (ref.disputedAt == 0) revert NotDisputed();
        if (ref.resolved) revert AlreadyResolved();
        (IArbitration.Outcome outcome, uint16 providerBps, bytes32 resolutionHash) = _arbitration.decision(jobId);
        if (outcome != IArbitration.Outcome.Complete && outcome != IArbitration.Outcome.Lapsed) revert NotDecided();
        if (providerBps != FULL_BPS && !_squareJob.getJobRecord(jobId).hookResolvesPayout) {
            revert SplitNeedsAPayoutResolver();
        }

        ref.resolved = true;
        _squareJob.complete(jobId, resolutionHash, abi.encode(providerBps, complianceProof));
        _arbitration.settleBond(jobId);
        uint256 fee = _forwardFee();
        emit DecisionApplied(jobId, uint8(outcome), providerBps, msg.sender, fee);
    }

    function settlementHorizon() external view returns (uint48) {
        Window storage window = _current();
        return window.challengeWindow + window.disputeWindow + window.finalizeGrace;
    }

    function finalizeGrace() external view returns (uint48) {
        return _current().finalizeGrace;
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC165, IERC165) returns (bool) {
        return interfaceId == type(ISettlementHorizon).interfaceId || super.supportsInterface(interfaceId);
    }

    function squareJob() external view returns (address) {
        return address(_squareJob);
    }

    function arbitration() external view returns (address) {
        return address(_arbitration);
    }

    function challengeEndsAt(uint256 jobId) external view returns (uint48) {
        ISquareJob.JobRecord memory job = _squareJob.getJobRecord(jobId);
        if (job.evaluator != address(this)) return 0;
        if (job.submittedAt == 0) return 0;
        return job.submittedAt + windowFor(job.submittedAt).challengeWindow;
    }

    function windowFor(uint48 submittedAt) public view returns (Window memory) {
        uint256 i = _windows.length;
        while (i > 0) {
            i--;
            if (_windows[i].effectiveFrom <= submittedAt) return _windows[i];
        }
        return _windows[0];
    }

    function currentWindow() external view returns (Window memory) {
        return _windows[_windows.length - 1];
    }

    function disputeOf(uint256 jobId) external view returns (DisputeRef memory) {
        return _disputes[jobId];
    }

    function isDisputed(uint256 jobId) external view returns (bool) {
        DisputeRef storage ref = _disputes[jobId];
        return ref.disputedAt != 0 && !ref.resolved;
    }

    function finalizeReason(uint256 jobId, bytes32 deliverable) public pure returns (bytes32) {
        return keccak256(abi.encode("square.finalize.v1", jobId, deliverable));
    }

    function _submittedJob(uint256 jobId) private view returns (ISquareJob.JobRecord memory job) {
        job = _squareJob.getJobRecord(jobId);
        if (job.evaluator != address(this)) revert NotOurJob();
        if (job.status != ISquareJob.JobStatus.Submitted) revert NotSubmitted();
    }

    function _forwardFee() private returns (uint256 fee) {
        fee = _squareJob.withdrawable(address(this));
        if (fee > 0) _squareJob.withdrawTo(msg.sender, fee);
    }

    function _current() private view returns (Window storage) {
        return _windows[_windows.length - 1];
    }

    function _pushWindow(uint48 effectiveFrom, uint48 challengeWindow, uint48 disputeWindow, uint48 finalizeGrace_)
        private
    {
        if (challengeWindow == 0 || disputeWindow == 0 || finalizeGrace_ == 0) revert ZeroWindow();
        _windows.push(
            Window({
                effectiveFrom: effectiveFrom,
                challengeWindow: challengeWindow,
                disputeWindow: disputeWindow,
                finalizeGrace: finalizeGrace_
            })
        );
        emit WindowsConfigured(effectiveFrom, challengeWindow, disputeWindow);
        emit FinalizeGraceConfigured(finalizeGrace_);
    }
}
