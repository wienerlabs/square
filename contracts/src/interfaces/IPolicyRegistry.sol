// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title The on-chain half of the compliance policy
/// @notice A commitment to an institution's spending policy, and the daily
///         counter that makes the circuit's `daily_spent_before` signal mean
///         something.
///
/// The policy itself stays private. What lives here is a Poseidon commitment to
/// it — the circuit's `policy_data_hash`, public signal 1 — plus the running
/// total the compliance module holds a proof to. Everything the policy actually
/// says (the ceilings, the token whitelist, the blocked addresses, the allowed
/// hours) never reaches the chain.
interface IPolicyRegistry {
    /// @param commitment  Poseidon `policy_data_hash`. Zero means "no policy".
    /// @param dailyLimit  Public ceiling in USDC base units, 6 decimals.
    /// @param updatedAt   When the commitment last changed.
    struct Policy {
        bytes32 commitment;
        uint128 dailyLimit;
        uint64 updatedAt;
    }

    /// @param day    UTC day index, `timestamp / 86400`.
    /// @param spent  Base units recorded against that day.
    struct DailySpend {
        uint64 day;
        uint128 spent;
    }

    event PolicyCommitted(address indexed poster, bytes32 indexed commitment, uint128 dailyLimit);
    event SpendRecorded(address indexed poster, uint64 indexed day, uint256 amount, uint256 spentAfter);
    event SpenderUpdated(address indexed spender, bool allowed);

    error ZeroCommitment();
    error ZeroAddress();
    error NoPolicy(address poster);
    error NotASpender(address caller);
    error DailyLimitExceeded(address poster, uint256 spentBefore, uint256 amount, uint128 dailyLimit);

    /// @notice Commit to a policy for the caller, or replace the commitment.
    /// @dev Keyed by `msg.sender`: an institution writes its own row and there
    ///      is no path to anyone else's, not even for the owner.
    function setPolicy(bytes32 commitment, uint128 dailyLimit) external;

    /// @notice Add `amount` to `poster`'s spend for the current UTC day.
    /// @dev Callable only by a registered spender — the compliance module,
    ///      inline during a release.
    /// @return spentBefore The poster's total for the day *before* this
    ///         payment: the value the proof's `daily_spent_before` has to agree
    ///         with.
    function recordSpend(address poster, uint256 amount) external returns (uint256 spentBefore);

    /// @notice Allow or forbid an address to move counters.
    function setSpender(address spender, bool allowed) external;

    function policyOf(address poster) external view returns (Policy memory);
    function commitmentOf(address poster) external view returns (bytes32);
    function spentToday(address poster) external view returns (uint256);
    function currentDay() external view returns (uint64);
    function isSpender(address account) external view returns (bool);
}
