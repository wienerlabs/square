// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";
import {IPolicyRegistry} from "../src/interfaces/IPolicyRegistry.sol";

/// @notice The on-chain state the compliance module reads, and the counter it moves.
///
/// Two properties are worth stating up front, because the tests are shaped
/// around them.
///
/// The counter is what makes `daily_spent_before` mean anything. The circuit
/// takes it as a public signal and rule 2 checks `daily_spent_before + amount
/// <= max_daily` privately — but a prover free to claim zero every time makes
/// that check vacuous. The registry is the chain's own answer to "what has this
/// institution already spent today", and `recordSpend` returns it so the module
/// in #27 can hold a proof to it.
///
/// A day here is `block.timestamp / 86400`, which is what `UtcDayHourChecked`
/// in circuits/lib/timestamp.circom computes from the timestamp signal. Two
/// different definitions of "day" between the circuit and the counter would let
/// a payment land in one day for the policy and another for the ceiling.
contract PolicyRegistryTest is Test {
    PolicyRegistry internal registry;

    address internal owner = makeAddr("owner");
    address internal hook = makeAddr("hook");
    address internal alice = makeAddr("alice");
    address internal mallory = makeAddr("mallory");

    uint256 internal constant USDC = 1e6;
    uint128 internal constant LIMIT = 50_000e6; // 50,000 USDC, well inside uint64
    bytes32 internal constant COMMITMENT = bytes32(uint256(0x9f01));
    bytes32 internal constant OTHER_COMMITMENT = bytes32(uint256(0xbeef));

    function setUp() public {
        registry = new PolicyRegistry(owner);
        vm.prank(owner);
        registry.setSpender(hook, true);

        // Somewhere well inside a UTC day, so a test that adds hours does not
        // cross midnight by accident.
        vm.warp(1_788_356_730); // 2026-09-02T13:45:30Z
    }

    function _commit(address poster, uint128 limit) internal {
        vm.prank(poster);
        registry.setPolicy(COMMITMENT, limit);
    }

    function _record(address poster, uint256 amount) internal returns (uint256 spentBefore) {
        (spentBefore,) = registry.recordSpend(poster, amount);
    }

    function _verdict(address poster, uint256 amount) internal returns (IPolicyRegistry.Verdict verdict) {
        vm.prank(hook);
        (, verdict) = registry.recordSpend(poster, amount);
    }

    // ------------------------------------------------ the policy commitment

    function test_setPolicy_writesTheCommitmentAndTheLimit() public {
        _commit(alice, LIMIT);

        IPolicyRegistry.Policy memory policy = registry.policyOf(alice);
        assertEq(policy.commitment, COMMITMENT, "commitment");
        assertEq(policy.dailyLimit, LIMIT, "daily limit");
        assertEq(policy.updatedAt, uint64(block.timestamp), "updatedAt");
        assertEq(registry.commitmentOf(alice), COMMITMENT, "commitmentOf");
    }

    function test_setPolicy_emits() public {
        vm.expectEmit(true, true, false, true, address(registry));
        emit IPolicyRegistry.PolicyCommitted(alice, COMMITMENT, LIMIT, 1);
        _commit(alice, LIMIT);
    }

    /// The commitment is a Poseidon hash the circuit produced; the contract
    /// only ever compares 32 bytes and never computes one.
    function test_setPolicy_updatesInPlace() public {
        _commit(alice, LIMIT);

        vm.prank(alice);
        registry.setPolicy(OTHER_COMMITMENT, LIMIT / 2);

        IPolicyRegistry.Policy memory policy = registry.policyOf(alice);
        assertEq(policy.commitment, OTHER_COMMITMENT, "commitment replaced");
        assertEq(policy.dailyLimit, LIMIT / 2, "limit replaced");
    }

    /// Zero is how "no policy" reads, so it cannot also be a policy.
    function test_setPolicy_rejectsAZeroCommitment() public {
        vm.prank(alice);
        vm.expectRevert(IPolicyRegistry.ZeroCommitment.selector);
        registry.setPolicy(bytes32(0), LIMIT);
    }

    function test_policyOf_isEmptyBeforeAnyCommitment() public view {
        IPolicyRegistry.Policy memory policy = registry.policyOf(alice);
        assertEq(policy.commitment, bytes32(0));
        assertEq(policy.dailyLimit, 0);
    }

    // --------------------------------------------- who may update a policy

    /// The registry is keyed by the poster, so there is no function that writes
    /// somebody else's policy. Mallory's call writes Mallory's own row.
    function test_setPolicy_cannotTouchAnotherPostersPolicy() public {
        _commit(alice, LIMIT);

        vm.prank(mallory);
        registry.setPolicy(OTHER_COMMITMENT, type(uint64).max);

        assertEq(registry.commitmentOf(alice), COMMITMENT, "alice untouched");
        assertEq(registry.policyOf(alice).dailyLimit, LIMIT, "alice's limit untouched");
        assertEq(registry.commitmentOf(mallory), OTHER_COMMITMENT, "mallory wrote her own");
    }

    /// Not even the contract owner. An owner who can rewrite an institution's
    /// commitment is a backdoor around the whole compliance gate.
    function test_setPolicy_theOwnerCannotRewriteAPostersPolicy() public {
        _commit(alice, LIMIT);

        vm.prank(owner);
        registry.setPolicy(OTHER_COMMITMENT, 1);

        assertEq(registry.commitmentOf(alice), COMMITMENT, "alice untouched");
    }

    // -------------------------------------------------------- the counter

    function test_recordSpend_accumulatesWithinOneUtcDay() public {
        _commit(alice, LIMIT);

        vm.prank(hook);
        (uint256 before1,) = registry.recordSpend(alice, 5_000 * USDC);
        assertEq(before1, 0, "first payment of the day");

        vm.warp(block.timestamp + 2 hours);
        vm.prank(hook);
        (uint256 before2,) = registry.recordSpend(alice, 3_000 * USDC);

        assertEq(before2, 5_000 * USDC, "second payment sees the first");
        assertEq(registry.spentToday(alice), 8_000 * USDC, "running total");
    }

    /// The value returned is `daily_spent_before`: what the proof has to agree
    /// with for the private ceiling to have been checked against reality.
    function test_recordSpend_returnsTheSpendBeforeThisPayment() public {
        _commit(alice, LIMIT);

        vm.startPrank(hook);
        assertEq(_record(alice, 1_000 * USDC), 0);
        assertEq(_record(alice, 2_000 * USDC), 1_000 * USDC);
        assertEq(_record(alice, 4_000 * USDC), 3_000 * USDC);
        vm.stopPrank();
    }

    function test_recordSpend_emits() public {
        _commit(alice, LIMIT);
        uint64 day = registry.currentDay();

        vm.expectEmit(true, true, false, true, address(registry));
        emit IPolicyRegistry.SpendRecorded(alice, day, 1_000 * USDC, 1_000 * USDC);
        vm.prank(hook);
        registry.recordSpend(alice, 1_000 * USDC);
    }

    // ------------------------------------------------- the day boundary

    /// The reset is lazy: nothing has to run at midnight for yesterday's total
    /// to stop counting.
    function test_recordSpend_resetsAtTheUtcDayBoundary() public {
        _commit(alice, LIMIT);

        vm.prank(hook);
        registry.recordSpend(alice, 40_000 * USDC);
        assertEq(registry.spentToday(alice), 40_000 * USDC);

        uint64 dayBefore = registry.currentDay();
        vm.warp((uint256(dayBefore) + 1) * 1 days); // the first second of the next UTC day
        assertEq(registry.currentDay(), dayBefore + 1, "a new day");

        assertEq(registry.spentToday(alice), 0, "yesterday does not carry over");

        vm.prank(hook);
        assertEq(_record(alice, 40_000 * USDC), 0, "and the ceiling is free again");
    }

    /// One second before midnight is still yesterday.
    function test_spentToday_holdsUntilTheLastSecondOfTheDay() public {
        _commit(alice, LIMIT);
        vm.prank(hook);
        registry.recordSpend(alice, 1_000 * USDC);

        uint64 day = registry.currentDay();
        vm.warp((uint256(day) + 1) * 1 days - 1);
        assertEq(registry.currentDay(), day, "still the same day");
        assertEq(registry.spentToday(alice), 1_000 * USDC, "still counted");
    }

    /// The registry's day and the circuit's `day_index` are the same number.
    function test_currentDay_isTheCircuitsDayIndex() public {
        assertEq(registry.currentDay(), uint64(block.timestamp / 86400));
        vm.warp(1_788_356_730 + 3 days + 17 hours);
        assertEq(registry.currentDay(), uint64(block.timestamp / 86400));
    }

    // ---------------------------------------------------------- the ceiling

    function test_recordSpend_answersLimitExceededAndStillCountsTheRelease() public {
        _commit(alice, LIMIT);
        assertEq(uint8(_verdict(alice, 49_000 * USDC)), uint8(IPolicyRegistry.Verdict.Compliant));

        vm.expectEmit(true, true, false, true);
        emit IPolicyRegistry.ReleaseOutsidePolicy(
            alice, registry.currentDay(), 50_001 * USDC, LIMIT, IPolicyRegistry.Verdict.LimitExceeded
        );
        assertEq(uint8(_verdict(alice, 1_001 * USDC)), uint8(IPolicyRegistry.Verdict.LimitExceeded));
        assertEq(registry.spentToday(alice), 50_001 * USDC, "the money left, so the day carries it");
    }

    function test_recordSpend_allowsExactlyTheLimit() public {
        _commit(alice, LIMIT);
        assertEq(uint8(_verdict(alice, LIMIT)), uint8(IPolicyRegistry.Verdict.Compliant));
        assertEq(registry.spentToday(alice), LIMIT, "the limit itself is allowed");
        assertEq(uint8(_verdict(alice, 1)), uint8(IPolicyRegistry.Verdict.LimitExceeded));
        assertEq(registry.spentToday(alice), LIMIT + 1);
    }

    /// The release the module judges leaves escrow whatever the verdict, so a
    /// counter that skipped the refused ones would understate what the
    /// institution spent. Every release moves the counter; the verdict says
    /// whether it should have happened.
    function test_recordSpend_aReleaseOutsideThePolicyIsCountedLikeAnyOther() public {
        _commit(alice, LIMIT);
        _verdict(alice, 10_000 * USDC);
        assertEq(uint8(_verdict(alice, LIMIT)), uint8(IPolicyRegistry.Verdict.LimitExceeded));
        assertEq(registry.spentToday(alice), 10_000 * USDC + LIMIT, "counted");
        assertEq(uint8(_verdict(alice, 1)), uint8(IPolicyRegistry.Verdict.LimitExceeded), "and stays outside");
    }

    /// Fail closed. A zero limit is "this policy authorises no spending", not
    /// "unlimited" — the other reading turns a forgotten field into a hole.
    function test_recordSpend_aZeroLimitAuthorisesNothing() public {
        _commit(alice, 0);
        assertEq(uint8(_verdict(alice, 1)), uint8(IPolicyRegistry.Verdict.LimitExceeded));
        assertEq(registry.spentToday(alice), 1);
    }

    function test_recordSpend_neverRevertsOnPolicyGroundsSoAModuleCannotLoseTheAdvance() public {
        _commit(alice, 0);
        vm.prank(hook);
        (bool ok,) = address(registry).call(
            abi.encodeCall(IPolicyRegistry.recordSpend, (alice, type(uint64).max))
        );
        assertTrue(ok, "a refused release is an answer, not a revert");
        assertEq(registry.spentToday(alice), type(uint64).max);
    }

    function test_recordSpend_refusesATotalTheCounterCannotHold() public {
        _commit(alice, LIMIT);
        vm.prank(hook);
        vm.expectRevert(
            abi.encodeWithSelector(IPolicyRegistry.SpendOverflow.selector, alice, uint256(type(uint128).max) + 1)
        );
        registry.recordSpend(alice, uint256(type(uint128).max) + 1);
    }

    // ------------------------------------------------------ who may spend

    function test_recordSpend_onlyASpenderMayIncrement() public {
        _commit(alice, LIMIT);

        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(IPolicyRegistry.NotASpender.selector, mallory));
        registry.recordSpend(alice, 1 * USDC);
    }

    /// The institution's own key is not a spender either. The counter moves
    /// during a release, driven by the module, not by whoever holds the policy.
    function test_recordSpend_thePosterIsNotASpender() public {
        _commit(alice, LIMIT);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPolicyRegistry.NotASpender.selector, alice));
        registry.recordSpend(alice, 1 * USDC);
    }

    function test_recordSpend_answersNoPolicyAndStillCountsTheRelease() public {
        vm.expectEmit(true, true, false, true);
        emit IPolicyRegistry.ReleaseOutsidePolicy(
            alice, registry.currentDay(), 1 * USDC, 0, IPolicyRegistry.Verdict.NoPolicy
        );
        assertEq(uint8(_verdict(alice, 1 * USDC)), uint8(IPolicyRegistry.Verdict.NoPolicy));
        assertEq(registry.spentToday(alice), 1 * USDC, "spent before any policy existed, and remembered");
    }

    /// Spending authority is the institution's, not the agent's: the counter is
    /// keyed by the poster passed in, never by whoever called.
    function test_recordSpend_countsAgainstThePosterNotTheCaller() public {
        _commit(alice, LIMIT);
        _commit(mallory, LIMIT);

        vm.prank(hook);
        registry.recordSpend(alice, 7_000 * USDC);

        assertEq(registry.spentToday(alice), 7_000 * USDC, "alice charged");
        assertEq(registry.spentToday(mallory), 0, "mallory untouched");
        assertEq(registry.spentToday(hook), 0, "the caller is not an account here");
    }

    // ------------------------------------------------------- administration

    function test_setSpender_ownerOnly() public {
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, mallory));
        registry.setSpender(mallory, true);

        assertFalse(registry.isSpender(mallory));
    }

    function test_setSpender_canBeRevoked() public {
        assertTrue(registry.isSpender(hook));

        vm.prank(owner);
        registry.setSpender(hook, false);

        assertFalse(registry.isSpender(hook));
        _commit(alice, LIMIT);
        vm.prank(hook);
        vm.expectRevert(abi.encodeWithSelector(IPolicyRegistry.NotASpender.selector, hook));
        registry.recordSpend(alice, 1 * USDC);
    }

    function test_setSpender_rejectsTheZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(IPolicyRegistry.ZeroAddress.selector);
        registry.setSpender(address(0), true);
    }

    /// Two-step, because the owner is meant to be a Safe and a single-step
    /// transfer to a mistyped address is unrecoverable.
    function test_ownershipTransferIsTwoStep() public {
        address next = makeAddr("next-safe");

        vm.prank(owner);
        registry.transferOwnership(next);
        assertEq(registry.owner(), owner, "not yet");

        vm.prank(next);
        registry.acceptOwnership();
        assertEq(registry.owner(), next, "now");
    }

    function test_constructor_rejectsTheZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new PolicyRegistry(address(0));
    }

    // -------------------------------------------------- what the proof can carry

    /// The circuit constrains daily_spent_before to 64 bits. A ceiling above
    /// that would let the counter reach a value no proof could ever carry, and
    /// the release would then fail in a way indistinguishable from a policy
    /// mismatch.
    function test_setPolicy_refusesACeilingTheProofCannotExpress() public {
        uint128 tooBig = uint128(type(uint64).max) + 1;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPolicyRegistry.LimitExceedsProofRange.selector, tooBig));
        registry.setPolicy(COMMITMENT, tooBig);
    }

    function test_setPolicy_allowsExactlyTheProofRange() public {
        vm.prank(alice);
        registry.setPolicy(COMMITMENT, type(uint64).max);
        assertEq(registry.policyOf(alice).dailyLimit, type(uint64).max);
    }

    // ------------------------------------------------------------ the epoch

    /// A proof is built against one version of a policy. Without a monotonic
    /// version nobody can tell the commitment was replaced between generating
    /// the proof and verifying it — and `updatedAt` cannot serve, because two
    /// writes in one block share a timestamp.
    function test_setPolicy_bumpsTheEpochEveryTime() public {
        assertEq(registry.epochOf(alice), 0, "no policy, no epoch");

        _commit(alice, LIMIT);
        assertEq(registry.epochOf(alice), 1);

        vm.prank(alice);
        registry.setPolicy(OTHER_COMMITMENT, LIMIT);
        assertEq(registry.epochOf(alice), 2);
    }

    function test_epoch_movesEvenWhenTheTimestampDoesNot() public {
        _commit(alice, LIMIT);
        uint64 at = registry.policyOf(alice).updatedAt;

        vm.prank(alice);
        registry.setPolicy(OTHER_COMMITMENT, LIMIT);

        assertEq(registry.policyOf(alice).updatedAt, at, "same block, same timestamp");
        assertEq(registry.epochOf(alice), 2, "the epoch still moved");
    }

    // ------------------------------------------------ the day is a calendar day

    /// Not a rolling 24 hours: the whole ceiling at 23:59:59 and the whole of it
    /// again one second later is within the policy. Asserted rather than left
    /// implicit, because it is the kind of thing a reader assumes the other way.
    function test_recordSpend_theCeilingIsPerCalendarDayNotPerRollingDay() public {
        _commit(alice, LIMIT);

        uint64 day = registry.currentDay();
        vm.warp((uint256(day) + 1) * 1 days - 1); // 23:59:59
        vm.prank(hook);
        registry.recordSpend(alice, LIMIT);

        vm.warp((uint256(day) + 1) * 1 days); // 00:00:00, one second later
        vm.prank(hook);
        registry.recordSpend(alice, LIMIT);

        assertEq(registry.spentToday(alice), LIMIT, "a fresh day");
        // Twice the daily ceiling inside one second. Bounding the burst is the
        // per-transaction ceiling's job, inside the private policy.
    }

    // ------------------------------------------------------ the hazard, named

    /// A client can zero its own ceiling at any time. Before #180 that made
    /// `recordSpend` revert, the revert propagated out of `SquareJob.complete`,
    /// and combined with square#90 it was a way for a client to refuse to pay
    /// for delivered work at the cost of one transaction. The registry now
    /// answers instead of reverting, so the lever moves the verdict and not the
    /// money: every further release is recorded as outside the policy and
    /// still completes. See docs/decisions/public-daily-ceiling.md and
    /// docs/decisions/hook-failure-modes.md.
    function test_theClientCanZeroItsOwnCeilingButCannotBlockARelease() public {
        _commit(alice, LIMIT);
        _verdict(alice, 1_000 * USDC);

        vm.prank(alice);
        registry.setPolicy(COMMITMENT, 0);

        assertEq(uint8(_verdict(alice, 1)), uint8(IPolicyRegistry.Verdict.LimitExceeded));
        assertEq(registry.spentToday(alice), 1_000 * USDC + 1, "the release happened and is on the record");
    }

    // ---------------------------------------------------------- renouncing

    /// The owner's only power is the spender set, and `recordSpend` is
    /// unreachable without a registered spender. Renouncing would freeze that
    /// set permanently and with it every compliance-gated release.
    function test_renounceOwnershipIsDisabled() public {
        vm.prank(owner);
        vm.expectRevert(IPolicyRegistry.RenounceDisabled.selector);
        registry.renounceOwnership();

        assertEq(registry.owner(), owner);
    }

    // ------------------------------------------------------------- property

    /// However the day and the payments fall, every release is counted and the
    /// verdict says whether the day stayed within the ceiling.
    function testFuzz_everyReleaseCountsAndTheVerdictFollowsTheCeiling(uint128 limit, uint96 a, uint96 b, uint32 gap)
        public
    {
        limit = uint128(bound(limit, 1, type(uint64).max));
        _commit(alice, limit);

        vm.startPrank(hook);
        (uint256 beforeA, IPolicyRegistry.Verdict verdictA) = registry.recordSpend(alice, a);
        assertEq(beforeA, 0);
        assertEq(uint8(verdictA), uint8(a <= limit ? IPolicyRegistry.Verdict.Compliant : IPolicyRegistry.Verdict.LimitExceeded));
        assertEq(registry.spentToday(alice), a, "counted whatever the verdict");

        uint64 dayBefore = registry.currentDay();
        vm.warp(block.timestamp + gap);
        uint256 carried = registry.currentDay() == dayBefore ? registry.spentToday(alice) : 0;

        (uint256 beforeB, IPolicyRegistry.Verdict verdictB) = registry.recordSpend(alice, b);
        assertEq(beforeB, carried);
        bool within = carried + b <= limit;
        assertEq(uint8(verdictB), uint8(within ? IPolicyRegistry.Verdict.Compliant : IPolicyRegistry.Verdict.LimitExceeded));
        assertEq(registry.spentToday(alice), carried + b, "counted whatever the verdict");
        vm.stopPrank();
    }
}
