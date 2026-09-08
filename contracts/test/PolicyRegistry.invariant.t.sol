// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";

/// @notice Drives the registry the way the system will: posters write their own
///         policies, one spender moves counters, and time passes.
///
/// Calls that are supposed to fail are swallowed here rather than asserted.
/// An invariant run is not the place to check that a revert has the right
/// selector — PolicyRegistry.t.sol does that — and a handler that propagates
/// expected reverts spends the whole run bouncing off them instead of reaching
/// interesting states.
contract PolicyRegistryHandler is Test {
    PolicyRegistry public immutable registry;
    address[3] public posters;

    /// The highest total seen for each poster on each day, so monotonicity
    /// within a day can be checked rather than assumed.
    mapping(address => mapping(uint64 => uint256)) public highWater;

    /// Set if any `recordSpend` ever succeeded in taking a poster's day past
    /// the ceiling that was in force at the moment of that call. This, and not
    /// `spentToday <= dailyLimit`, is the property the contract actually
    /// promises — see the note on the test below.
    bool public breached;

    constructor(PolicyRegistry registry_) {
        registry = registry_;
        posters = [makeAddr("poster-a"), makeAddr("poster-b"), makeAddr("poster-c")];
    }

    function _poster(uint256 seed) internal view returns (address) {
        return posters[seed % posters.length];
    }

    function setPolicy(uint256 seed, bytes32 commitment, uint128 dailyLimit) external {
        address poster = _poster(seed);
        vm.prank(poster);
        try registry.setPolicy(commitment, dailyLimit) {} catch {}
    }

    function recordSpend(uint256 seed, uint256 amount) external {
        address poster = _poster(seed);
        uint128 ceilingInForce = registry.policyOf(poster).dailyLimit;

        try registry.recordSpend(poster, amount) {
            if (registry.spentToday(poster) > ceilingInForce) breached = true;
        } catch {}

        uint64 day = registry.currentDay();
        uint256 spent = registry.spentToday(poster);
        if (spent > highWater[poster][day]) highWater[poster][day] = spent;
    }

    function warp(uint32 seconds_) external {
        vm.warp(block.timestamp + seconds_);
    }

    function posterCount() external view returns (uint256) {
        return posters.length;
    }
}

/// @notice The two properties the counter has to hold whatever the sequence is.
///
/// The first is the contract's whole reason for existing: a day's spend never
/// passes the ceiling the institution set, however the calls interleave and
/// however time moves. The second is that a refused payment cannot consume
/// allowance — expressed as monotonicity, because the only way a total can fall
/// inside one day is if a revert moved it.
contract PolicyRegistryInvariantTest is Test {
    PolicyRegistry internal registry;
    PolicyRegistryHandler internal handler;

    address internal owner = makeAddr("owner");

    function setUp() public {
        registry = new PolicyRegistry(owner);
        handler = new PolicyRegistryHandler(registry);

        // The handler is the compliance module: the only address that may move
        // a counter.
        vm.prank(owner);
        registry.setSpender(address(handler), true);

        vm.warp(1_788_356_730); // 2026-09-02T13:45:30Z
        targetContract(address(handler));
    }

    /// No release ever takes a day past the ceiling **in force when it
    /// happened**.
    ///
    /// The naive form — `spentToday(p) <= policyOf(p).dailyLimit`, always —
    /// looks like the property and is false, and this test found the
    /// counterexample on its first run in three calls:
    ///
    ///     setPolicy(limit = 86400)   → poster's ceiling is 86400
    ///     recordSpend(566)           → succeeds, the day stands at 566
    ///     setPolicy(limit = 0)       → the ceiling is now below the day
    ///
    /// Nothing was overspent: 566 was within the ceiling that existed when it
    /// was spent. What the sequence shows is that a poster can move its own
    /// ceiling *under* a day already in progress, which is the same lever as
    /// `test_theClientCanZeroItsOwnCeilingAndBlockEveryRelease` and the reason
    /// docs/decisions/public-daily-ceiling.md has a section on square#90. The
    /// registry is not the right place to forbid it, so the invariant states
    /// what the contract actually promises instead of overstating it.
    function invariant_noReleasePassedTheCeilingInForce() public view {
        assertFalse(handler.breached(), "a release took a day past the ceiling in force at the time");
    }

    function invariant_aDaysTotalOnlyEverRises() public view {
        uint64 day = registry.currentDay();
        for (uint256 i = 0; i < handler.posterCount(); i++) {
            address poster = handler.posters(i);
            assertEq(
                registry.spentToday(poster),
                handler.highWater(poster, day),
                "a total fell within one day, so a refused payment moved the counter"
            );
        }
    }
}
