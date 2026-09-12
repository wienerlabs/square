// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IPolicyRegistry} from "./interfaces/IPolicyRegistry.sol";
import {SCALAR_FIELD} from "./interfaces/IGroth16Verifier.sol";

/// @title PolicyRegistry
/// @notice What the compliance module reads when it judges a release, and the
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
/// this institution already spent today", so #27 can mark a release as
/// non-compliant when its signal 5 disagrees with it.
///
/// ## The verdict is a return value, and every release is counted
///
/// docs/decisions/hook-failure-modes.md binds the module that calls this
/// contract: compliance is a signal on the release, not a lock on the escrow,
/// and a verdict travels as a return value or a payout split, never as a
/// revert. `SquareHook._checkRelease` wraps the module in `try/catch`, so a
/// module that reverted would still see the job complete and would lose its
/// own state changes, this counter's advance included. `recordSpend` therefore
/// never reverts on policy grounds: it records the release, returns a
/// `Verdict`, and emits `ReleaseOutsidePolicy` when the verdict is not
/// `Compliant`. The counter may stand above the ceiling afterwards; that is
/// the truthful reading, because the money left.
///
/// ## Poseidon is not computed here
///
/// `commitment` is the circuit's `policy_data_hash`, and this contract only
/// ever compares 32 bytes to 32 bytes. Running Poseidon in Solidity would cost
/// more than the pairing check it is meant to support.
///
/// ## The counter moves inline, during the release
///
/// Aperture had two flows. `verify_payment_v2_with_transfer` advanced
/// `OperatorState.daily_spent_lamports` inline and rejected a stale proof with
/// `DailySpentMismatch`, which is the behaviour this contract reproduces. Its
/// legacy two-transaction flow deferred the advance: `verify_v2` emitted a
/// `pending_proof_hash` and a separate `transferChecked` consumed it through
/// the Token-2022 transfer hook's `record_payment` — a hook that cannot fire
/// for a legacy SPL mint, and USDC and USDT are legacy SPL. So the deferral was
/// real, in one flow of two.
///
/// **This contract is not safe from the same failure by construction, and the
/// difference is not the absence of a hook.** `recordSpend` is `onlySpender`;
/// its only reachable caller is a compliance module, called only from
/// `SquareHook._checkRelease`, and the module is optional. The hook of the
/// 2026-09-09 Arc Testnet stack, `0xb44aCCBb8d1eae0e2D2e8B33CEC32f1fD613e7e6`
/// (docs/deploy/redeploy-2026-09-09.md), returns the zero address from
/// `complianceModule()`, as the 2026-09-07 hook at `0x92EC31aA…` did, so the
/// ceiling is inert exactly as aperture's was until square#27 installs a
/// module. What is fixed here is that the advance cannot be skipped *once the
/// module is installed*, because it happens in the same call that judges the
/// release, and cannot be rolled back by the module's own failure, because it
/// is never expressed as a revert.
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
///
/// It is a **calendar day, not a rolling 24 hours**. An institution can spend
/// its whole ceiling at 23:59:59 and the whole of it again at 00:00:00 — twice
/// the daily limit inside one second, and within the policy. That is what the
/// circuit's own time decomposition means by a day, and the two have to agree;
/// a rolling window here would put the counter and rule 2 on different clocks.
/// Bounding the burst is the per-transaction ceiling's job, and it stays
/// private inside the commitment.
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
        // The circuit constrains daily_spent_before to 64 bits (Num2Bits(64) in
        // payment.circom). A ceiling above that would let this registry
        // accumulate a counter no proof could ever carry, and the release would
        // then fail in a way indistinguishable from a policy mismatch.
        if (dailyLimit > type(uint64).max) revert LimitExceedsProofRange(dailyLimit);
        // And the commitment, for the same reason the ceiling is bounded above.
        //
        // It is compared against public signal 1, which is a Poseidon output and
        // therefore always below the BN254 scalar field; `Groth16Verifier`
        // refuses any signal at or above it before it reaches a precompile. A
        // commitment above the field is a value no verifying proof can carry, so
        // every gated release for this poster would be refused with
        // `policy commitment` — the same reason a genuine policy rotation
        // produces, and permanent rather than transient (#231).
        //
        // It is easy to reach by accident: four in five uniformly distributed
        // 32-byte values are at or above the field, so an operator who hands
        // over a keccak digest rather than a Poseidon commitment lands here
        // most of the time. This repository's own test did
        // (`keccak256("some other policy")` is above the field).
        if (uint256(commitment) >= SCALAR_FIELD) revert CommitmentOutsideProofRange(commitment);

        Policy storage policy = _policies[msg.sender];
        policy.commitment = commitment;
        policy.dailyLimit = dailyLimit;
        policy.updatedAt = uint64(block.timestamp);
        uint64 epoch;
        unchecked {
            epoch = policy.epoch + 1;
        }
        policy.epoch = epoch;

        emit PolicyCommitted(msg.sender, commitment, dailyLimit, epoch);
    }

    /// @dev Disabled. The owner's only power is the spender set, and
    ///      `recordSpend` is unreachable without a registered spender, so
    ///      renouncing would freeze that set permanently and with it every
    ///      compliance-gated release.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // -------------------------------------------------------- the counter

    /// @inheritdoc IPolicyRegistry
    function recordSpend(address poster, uint256 amount)
        external
        returns (uint256 spentBefore, Verdict verdict)
    {
        if (!_spenders[msg.sender]) revert NotASpender(msg.sender);

        Policy memory policy = _policies[poster];
        uint64 day = _today();
        DailySpend storage record = _spend[poster];
        spentBefore = record.day == day ? record.spent : 0;

        uint256 spentAfter = spentBefore + amount;
        if (spentAfter > type(uint128).max) revert SpendOverflow(poster, spentAfter);

        // Fail closed. A zero limit authorises no spending rather than
        // unlimited spending — the other reading turns a field somebody forgot
        // to set into a hole in the ceiling.
        if (policy.commitment == bytes32(0)) verdict = Verdict.NoPolicy;
        else if (spentAfter > policy.dailyLimit) verdict = Verdict.LimitExceeded;
        else verdict = Verdict.Compliant;

        record.day = day;
        // Bounded by the overflow check above, so the cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        record.spent = uint128(spentAfter);

        emit SpendRecorded(poster, day, amount, spentAfter);
        if (verdict != Verdict.Compliant) {
            emit ReleaseOutsidePolicy(poster, day, spentAfter, policy.dailyLimit, verdict);
        }
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
    function epochOf(address poster) external view returns (uint64) {
        return _policies[poster].epoch;
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
