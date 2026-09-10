// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title The on-chain half of the compliance policy
/// @notice A commitment to an institution's spending policy, and the daily
///         counter that makes the circuit's `daily_spent_before` signal mean
///         something.
///
/// The policy itself stays off chain. What lives here is a Poseidon commitment
/// to it — the circuit's `policy_data_hash`, public signal 1 — plus the running
/// total the compliance module holds a proof to, and the public daily ceiling
/// argued in docs/decisions/public-daily-ceiling.md.
///
/// The commitment is `Poseidon(8)` over eight policy fields and **carries no
/// nonce** (circuits/payment.circom:395-404). It hides the policy only as far
/// as those fields are hard to guess, and `max_daily` is one of them and is
/// published here as `dailyLimit`. What the hiding actually rests on, and what
/// an operator has to do to keep it true, is written down in
/// docs/decisions/public-daily-ceiling.md — read it before describing anything
/// here as private.
///
/// The registry judges, it does not lock. `recordSpend` answers with a
/// `Verdict` and never reverts on policy grounds, because the release it is
/// asked about leaves escrow whatever the answer is
/// (docs/decisions/hook-failure-modes.md): a compliance module expresses its
/// verdict through its return value or the payout split, never through a
/// revert, and a revert would also roll back the counter's own advance.
interface IPolicyRegistry {
    /// @notice What the registry found when a release was recorded.
    /// @dev `Compliant` means the poster has a policy and the day's total after
    ///      this release is within its ceiling. The other two name why it is
    ///      not; the release is counted in every case.
    enum Verdict {
        Compliant,
        NoPolicy,
        LimitExceeded
    }

    /// @param commitment  Poseidon `policy_data_hash`. Zero means "no policy".
    /// @param dailyLimit  Public ceiling in USDC base units, 6 decimals. Bounded
    ///        by `type(uint64).max` because the circuit constrains
    ///        `daily_spent_before` to 64 bits (`Num2Bits(64)`), and a counter
    ///        the proof system cannot express is a state nobody could ever
    ///        prove their way out of.
    /// @param updatedAt   When the commitment last changed.
    /// @param epoch       Incremented on every `setPolicy`. A proof is built
    ///        against one version of a policy; without a monotonic version a
    ///        consumer cannot tell that the commitment was replaced between
    ///        generating the proof and verifying it. `updatedAt` cannot serve —
    ///        two writes in one block share a timestamp. Nothing in this tree
    ///        reads it yet: the reader is the compliance module of square#27,
    ///        which binds a proof to the epoch it was built against. Until that
    ///        module exists the field is written and emitted, not consumed.
    struct Policy {
        bytes32 commitment;
        uint128 dailyLimit;
        uint64 updatedAt;
        uint64 epoch;
    }

    /// @param day    UTC day index, `timestamp / 86400`.
    /// @param spent  Base units recorded against that day.
    struct DailySpend {
        uint64 day;
        uint128 spent;
    }

    event PolicyCommitted(
        address indexed poster, bytes32 indexed commitment, uint128 dailyLimit, uint64 epoch
    );
    event SpendRecorded(address indexed poster, uint64 indexed day, uint256 amount, uint256 spentAfter);
    event ReleaseOutsidePolicy(
        address indexed poster, uint64 indexed day, uint256 spentAfter, uint128 dailyLimit, Verdict verdict
    );
    event SpenderUpdated(address indexed spender, bool allowed);

    error ZeroCommitment();
    error ZeroAddress();
    error NotASpender(address caller);
    error LimitExceedsProofRange(uint128 dailyLimit);
    error RenounceDisabled();
    error SpendOverflow(address poster, uint256 spentAfter);

    /// @notice Commit to a policy for the caller, or replace the commitment.
    /// @dev Keyed by `msg.sender`: an institution writes its own row and there
    ///      is no path to anyone else's, not even for the owner.
    function setPolicy(bytes32 commitment, uint128 dailyLimit) external;

    /// @notice Add `amount` to `poster`'s spend for the current UTC day.
    ///
    /// @dev Callable only by a registered spender — the compliance module,
    ///      inline during a release.
    ///
    ///      **`amount` is what is released to the payee, not what left the
    ///      client's treasury.** It is the same number the proof carries as
    ///      public signal 3, which is what makes the counter and the circuit's
    ///      rule 2 talk about the same quantity. The only caller that can reach
    ///      this is the compliance module from `SquareHook._checkRelease`,
    ///      where it is `netPayout(jobId) * providerBps / 10_000` — the budget
    ///      after the platform and evaluator fees and after any arbitration
    ///      split.
    ///
    ///      The consequence, stated rather than left to be discovered: fees and
    ///      the part of a disputed budget refunded to the client are **not**
    ///      counted against the daily ceiling. The ceiling bounds what agents
    ///      are paid, not what the escrow consumed.
    ///
    ///      The release is counted whatever the verdict. The kernel completes
    ///      the job even when the compliance check fails, so a counter that
    ///      skipped refused releases would answer "what has this institution
    ///      spent today" with a number below what actually left. The only
    ///      reverts are the caller not being a spender and a total that no
    ///      longer fits the counter, neither of which a policy can cause.
    ///
    /// @return spentBefore The poster's total for the day *before* this
    ///         payment: the value the proof's `daily_spent_before` has to agree
    ///         with.
    /// @return verdict Whether the release was within the poster's policy, and
    ///         if not, why.
    function recordSpend(address poster, uint256 amount) external returns (uint256 spentBefore, Verdict verdict);

    /// @notice Allow or forbid an address to move counters.
    function setSpender(address spender, bool allowed) external;

    function policyOf(address poster) external view returns (Policy memory);
    function epochOf(address poster) external view returns (uint64);
    function commitmentOf(address poster) external view returns (bytes32);
    function spentToday(address poster) external view returns (uint256);
    function currentDay() external view returns (uint64);
    function isSpender(address account) external view returns (bool);
}
