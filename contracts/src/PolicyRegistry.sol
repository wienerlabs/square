// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IPolicyRegistry} from "./interfaces/IPolicyRegistry.sol";

/// @title PolicyRegistry
/// @notice What the compliance module reads before it lets money out, and the
///         one number it writes on the way through.
///
/// The EVM counterpart of aperture's `PolicyAccount` + `OperatorState` pair.
///
/// ## Why a counter has to exist on chain
///
/// The circuit's second rule is `daily_spent_before + amount <= max_daily`, and
/// `max_daily` is a private input — the ceiling never reaches the chain. But
/// `daily_spent_before` is public signal 5, supplied by whoever builds the
/// proof, and a prover free to claim zero every time makes rule 2 vacuous: each
/// payment individually fits under a ceiling it never approaches, and the daily
/// cap enforces nothing. This registry is the chain's own answer to "what has
/// this institution already spent today", so #27 can refuse a proof whose
/// signal 5 disagrees with it.
///
/// ## Poseidon is not computed here
///
/// `commitment` is the circuit's `policy_data_hash`, and this contract only
/// ever compares 32 bytes to 32 bytes. Running Poseidon in Solidity would cost
/// more than the pairing check it is meant to support.
///
/// ## The counter moves inline, during the release
///
/// Aperture deferred this to a Solana transfer hook, which never fired for
/// legacy SPL mints — so its daily ceiling was silently inert. There is no such
/// hook on the EVM path, and doing it inline fixes that failure for free.
///
/// ## Whose spend it is
///
/// The counter is keyed by the poster: the institution that funded the job,
/// which is `SquareJob`'s `client`. Spending authority belongs to the
/// institution, not to the agent executing against it, so two agents working
/// for one institution draw on one allowance.
///
/// ## The day
///
/// `block.timestamp / 86400`, the same UTC day index `UtcDayHourChecked` in
/// circuits/lib/timestamp.circom derives from the timestamp signal. Two
/// different notions of "day" between the circuit and this counter would let a
/// payment land in one day for the policy's time-window rule and another for
/// its ceiling. The reset is lazy: a stored day that is not today reads as
/// zero, so nothing has to run at midnight.
contract PolicyRegistry is IPolicyRegistry, Ownable2Step {
    mapping(address poster => Policy) private _policies;
    mapping(address poster => DailySpend) private _spend;
    mapping(address spender => bool) private _spenders;

    /// @param initialOwner Expected to be a Safe. It administers the spender
    ///        set and nothing else — it cannot write or alter a poster's policy.
    constructor(address initialOwner) Ownable(initialOwner) {}

    // ------------------------------------------------------------- policies

    /// @inheritdoc IPolicyRegistry
    function setPolicy(bytes32 commitment, uint128 dailyLimit) external {
        if (commitment == bytes32(0)) revert ZeroCommitment();

        Policy storage policy = _policies[msg.sender];
        policy.commitment = commitment;
        policy.dailyLimit = dailyLimit;
        policy.updatedAt = uint64(block.timestamp);

        emit PolicyCommitted(msg.sender, commitment, dailyLimit);
    }

    // -------------------------------------------------------- the counter

    /// @inheritdoc IPolicyRegistry
    function recordSpend(address poster, uint256 amount) external returns (uint256 spentBefore) {
        if (!_spenders[msg.sender]) revert NotASpender(msg.sender);

        Policy memory policy = _policies[poster];
        if (policy.commitment == bytes32(0)) revert NoPolicy(poster);

        uint64 day = _today();
        DailySpend storage record = _spend[poster];
        spentBefore = record.day == day ? record.spent : 0;

        uint256 spentAfter = spentBefore + amount;
        // Fail closed. A zero limit authorises no spending rather than
        // unlimited spending — the other reading turns a field somebody forgot
        // to set into a hole in the ceiling.
        if (spentAfter > policy.dailyLimit) {
            revert DailyLimitExceeded(poster, spentBefore, amount, policy.dailyLimit);
        }

        record.day = day;
        // The check above bounds spentAfter by policy.dailyLimit, which is a
        // uint128, so the cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        record.spent = uint128(spentAfter);

        emit SpendRecorded(poster, day, amount, spentAfter);
    }

    // -------------------------------------------------------- administration

    /// @inheritdoc IPolicyRegistry
    function setSpender(address spender, bool allowed) external onlyOwner {
        if (spender == address(0)) revert ZeroAddress();
        _spenders[spender] = allowed;
        emit SpenderUpdated(spender, allowed);
    }

    // --------------------------------------------------------------- views

    /// @inheritdoc IPolicyRegistry
    function policyOf(address poster) external view returns (Policy memory) {
        return _policies[poster];
    }

    /// @inheritdoc IPolicyRegistry
    function commitmentOf(address poster) external view returns (bytes32) {
        return _policies[poster].commitment;
    }

    /// @inheritdoc IPolicyRegistry
    function spentToday(address poster) external view returns (uint256) {
        DailySpend memory record = _spend[poster];
        return record.day == _today() ? record.spent : 0;
    }

    /// @inheritdoc IPolicyRegistry
    function currentDay() external view returns (uint64) {
        return _today();
    }

    /// @inheritdoc IPolicyRegistry
    function isSpender(address account) external view returns (bool) {
        return _spenders[account];
    }

    function _today() private view returns (uint64) {
        return uint64(block.timestamp / 1 days);
    }
}
