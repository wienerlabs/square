// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IArbitration} from "./interfaces/IArbitration.sol";
import {IKeeperEvaluator} from "./interfaces/IKeeperEvaluator.sol";
import {ISquareJob} from "./interfaces/ISquareJob.sol";

contract Arbitration is IArbitration, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 private constant FULL_BPS = 10_000;
    uint256 private constant MAX_ARBITERS = 255;

    IERC20 private immutable _token;
    IKeeperEvaluator private immutable _keeperEvaluator;
    ISquareJob private immutable _squareJob;

    uint32 private _currentVersion;
    uint16 private _bondBps;
    uint64 private _minBond;

    mapping(uint32 version => address[]) private _arbiters;
    mapping(uint32 version => uint8) private _threshold;
    mapping(uint32 version => mapping(address => uint8)) private _indexPlusOne;
    mapping(uint256 jobId => Dispute) private _disputes;
    mapping(uint256 jobId => mapping(bytes32 resolutionHash => uint256)) private _approvals;
    mapping(address account => uint256) private _withdrawable;

    modifier onlyKeeperEvaluator() {
        if (msg.sender != address(_keeperEvaluator)) revert OnlyKeeperEvaluator();
        _;
    }

    constructor(address keeperEvaluator_, address initialOwner, uint16 bondBps_, uint64 minBond_)
        Ownable(initialOwner)
    {
        if (keeperEvaluator_ == address(0)) revert ZeroAddress();
        _keeperEvaluator = IKeeperEvaluator(keeperEvaluator_);
        _squareJob = ISquareJob(_keeperEvaluator.squareJob());
        _token = IERC20(_squareJob.paymentToken());
        _setBondParameters(bondBps_, minBond_);
    }

    function setArbiters(address[] calldata arbiters, uint8 threshold) external onlyOwner {
        uint256 n = arbiters.length;
        if (n == 0 || n > MAX_ARBITERS || threshold == 0 || threshold > n) revert BadArbiterSet();
        uint32 version = ++_currentVersion;
        for (uint256 i = 0; i < n; i++) {
            address arbiter = arbiters[i];
            if (arbiter == address(0)) revert ZeroAddress();
            if (_indexPlusOne[version][arbiter] != 0) revert BadArbiterSet();
            _indexPlusOne[version][arbiter] = uint8(i + 1);
            _arbiters[version].push(arbiter);
        }
        _threshold[version] = threshold;
        emit ArbitersUpdated(version, arbiters, threshold);
    }

    function setBondParameters(uint16 bondBps_, uint64 minBond_) external onlyOwner {
        _setBondParameters(bondBps_, minBond_);
    }

    function open(uint256 jobId, address disputer, uint64 budget, uint48 resolveBy, bytes32)
        external
        onlyKeeperEvaluator
        nonReentrant
        returns (uint64 bond)
    {
        if (_currentVersion == 0) revert NoArbiters();
        if (_disputes[jobId].disputedAt != 0) revert DisputeExists();
        bond = bondFor(budget);
        uint48 now48 = uint48(block.timestamp);
        Dispute storage d = _disputes[jobId];
        d.disputer = disputer;
        d.bond = bond;
        d.disputedAt = now48;
        d.resolveBy = resolveBy;
        d.setVersion = _currentVersion;
        emit DisputeOpened(jobId, disputer, bond, now48, _currentVersion, resolveBy);
        _token.safeTransferFrom(disputer, address(this), bond);
    }

    function vote(uint256 jobId, Outcome outcome, uint16 providerBps) external nonReentrant {
        Dispute storage d = _disputes[jobId];
        if (d.disputedAt == 0) revert UnknownDispute();
        if (d.outcome != Outcome.None) revert AlreadyDecided();
        if (outcome == Outcome.Complete) {
            if (providerBps == 0 || providerBps > FULL_BPS) revert BadResolution();
        } else if (outcome == Outcome.Reject) {
            if (providerBps != 0) revert BadResolution();
        } else {
            revert BadResolution();
        }

        uint8 indexPlusOne = _indexPlusOne[d.setVersion][msg.sender];
        if (indexPlusOne == 0) revert NotAnArbiter();
        uint256 bit = 1 << (indexPlusOne - 1);
        if (d.voted & bit != 0) revert AlreadyVoted();
        d.voted |= bit;

        bytes32 hash = resolutionHash(jobId, outcome, providerBps);
        uint256 approvals = _approvals[jobId][hash] | bit;
        _approvals[jobId][hash] = approvals;
        emit VoteCast(jobId, msg.sender, hash, uint8(outcome), providerBps, approvals);

        if (_popcount(approvals) >= _threshold[d.setVersion]) _decide(jobId, d, outcome, providerBps, hash);
    }

    function lapse(uint256 jobId) external {
        Dispute storage d = _disputes[jobId];
        if (d.disputedAt == 0) revert UnknownDispute();
        if (d.outcome != Outcome.None) revert AlreadyDecided();
        if (block.timestamp < d.resolveBy) revert NotLapsed(d.resolveBy);
        d.outcome = Outcome.Lapsed;
        d.providerBps = FULL_BPS;
        d.resolutionHash = resolutionHash(jobId, Outcome.Lapsed, FULL_BPS);
        emit DisputeExpired(jobId);
        emit DecisionReached(jobId, uint8(Outcome.Lapsed), FULL_BPS, d.resolutionHash);
    }

    function settleBond(uint256 jobId) external onlyKeeperEvaluator {
        Dispute storage d = _disputes[jobId];
        if (d.outcome != Outcome.Complete && d.outcome != Outcome.Lapsed) revert NothingToSettle();
        ISquareJob.JobRecord memory job = _squareJob.getJobRecord(jobId);
        if (job.status != ISquareJob.JobStatus.Completed) revert NothingToSettle();
        address to = d.disputer;
        if (d.outcome == Outcome.Complete && d.providerBps == FULL_BPS) to = job.payee;
        _settleBond(jobId, d, to);
    }

    function withdraw() external {
        withdrawTo(msg.sender, _withdrawable[msg.sender]);
    }

    function withdrawTo(address to, uint256 amount) public nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = _withdrawable[msg.sender];
        if (amount > balance) revert InsufficientBalance();
        _withdrawable[msg.sender] = balance - amount;
        emit BondWithdrawn(msg.sender, to, amount);
        _token.safeTransfer(to, amount);
    }

    function decision(uint256 jobId) external view returns (Outcome, uint16, bytes32) {
        Dispute storage d = _disputes[jobId];
        return (d.outcome, d.providerBps, d.resolutionHash);
    }

    function disputeOf(uint256 jobId) external view returns (Dispute memory) {
        return _disputes[jobId];
    }

    function approvalsOf(uint256 jobId, bytes32 hash) external view returns (uint256) {
        return _approvals[jobId][hash];
    }

    function bondFor(uint64 budget) public view returns (uint64) {
        uint256 proportional = (uint256(budget) * _bondBps) / FULL_BPS;
        return proportional > _minBond ? uint64(proportional) : _minBond;
    }

    function arbiterSet(uint32 version) external view returns (address[] memory, uint8) {
        return (_arbiters[version], _threshold[version]);
    }

    function currentVersion() external view returns (uint32) {
        return _currentVersion;
    }

    function bondParameters() external view returns (uint16 bondBps, uint64 minBond) {
        return (_bondBps, _minBond);
    }

    function withdrawable(address account) external view returns (uint256) {
        return _withdrawable[account];
    }

    function resolutionHash(uint256 jobId, Outcome outcome, uint16 providerBps) public pure returns (bytes32) {
        return keccak256(abi.encode("square.resolution.v1", jobId, uint8(outcome), providerBps));
    }

    function _decide(uint256 jobId, Dispute storage d, Outcome outcome, uint16 providerBps, bytes32 hash) private {
        d.outcome = outcome;
        d.providerBps = providerBps;
        d.resolutionHash = hash;
        emit DecisionReached(jobId, uint8(outcome), providerBps, hash);
        if (outcome == Outcome.Reject) {
            _keeperEvaluator.applyRejection(jobId, hash);
            _settleBond(jobId, d, d.disputer);
        }
    }

    function _settleBond(uint256 jobId, Dispute storage d, address to) private {
        if (d.bondSettled) revert NothingToSettle();
        d.bondSettled = true;
        _withdrawable[to] += d.bond;
        emit BondSettled(jobId, to, d.bond);
    }

    function _setBondParameters(uint16 bondBps_, uint64 minBond_) private {
        if (bondBps_ > FULL_BPS) revert BadBondParameters();
        _bondBps = bondBps_;
        _minBond = minBond_;
        emit BondParametersUpdated(bondBps_, minBond_);
    }

    function _popcount(uint256 x) private pure returns (uint256 count) {
        while (x != 0) {
            x &= x - 1;
            count++;
        }
    }
}
