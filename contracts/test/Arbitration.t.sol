// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {ISquareJob} from "../src/interfaces/ISquareJob.sol";
import {IArbitration} from "../src/interfaces/IArbitration.sol";
import {IKeeperEvaluator} from "../src/interfaces/IKeeperEvaluator.sol";
import {KeeperEvaluator} from "../src/KeeperEvaluator.sol";
import {Arbitration} from "../src/Arbitration.sol";
import {MaliciousHook} from "./mocks/MaliciousHook.sol";

contract ArbitrationTest is BaseTest {
    uint256 internal constant BUDGET = 1_000 * USDC;

    function _disputed(uint256 budget) internal returns (uint256 jobId, uint64 bond) {
        jobId = submittedHookedJob(budget);
        bond = arbitration.bondFor(uint64(budget));
        vm.prank(client);
        keeper.dispute(jobId, keccak256("evidence"));
    }

    function test_bond_isTheLargerOfBpsAndFloor() public view {
        assertEq(arbitration.bondFor(uint64(BUDGET)), (BUDGET * BOND_BPS) / FULL_BPS);
        assertEq(arbitration.bondFor(uint64(2 * USDC)), MIN_BOND, "a tiny job still needs the absolute floor");
        assertEq(arbitration.bondFor(0), MIN_BOND);
    }

    function test_open_onlyKeeperEvaluator() public {
        vm.expectRevert(IArbitration.OnlyKeeperEvaluator.selector);
        vm.prank(stranger);
        arbitration.open(1, client, 1, 1, bytes32(0));
    }

    function test_open_requiresAnArbiterSet() public {
        KeeperEvaluator bare = new KeeperEvaluator(address(kernel), owner, CHALLENGE_WINDOW, DISPUTE_WINDOW, FINALIZE_GRACE);
        Arbitration empty = new Arbitration(address(bare), owner, BOND_BPS, MIN_BOND);
        vm.prank(owner);
        bare.setArbitration(address(empty));
        vm.prank(client);
        uint256 jobId = kernel.createJob(provider, address(bare), expiry(), "", address(0));
        vm.prank(provider);
        kernel.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        kernel.fund(jobId, BUDGET, "");
        vm.prank(provider);
        kernel.submit(jobId, DELIVERABLE, "");
        vm.expectRevert(IArbitration.NoArbiters.selector);
        vm.prank(client);
        bare.dispute(jobId, bytes32(0));
    }

    function test_vote_singleVoteDoesNotDecide() public {
        (uint256 jobId,) = _disputed(BUDGET);
        vote(arb1, jobId, IArbitration.Outcome.Reject, 0);
        (IArbitration.Outcome outcome,,) = arbitration.decision(jobId);
        assertEq(uint8(outcome), uint8(IArbitration.Outcome.None));
        assertEq(uint8(status(jobId)), uint8(ISquareJob.JobStatus.Submitted));
        bytes32 hash = arbitration.resolutionHash(jobId, IArbitration.Outcome.Reject, 0);
        assertEq(arbitration.approvalsOf(jobId, hash), 1);
    }

    function test_vote_sameArbiterCannotVoteTwice() public {
        (uint256 jobId,) = _disputed(BUDGET);
        vote(arb1, jobId, IArbitration.Outcome.Reject, 0);
        vm.expectRevert(IArbitration.AlreadyVoted.selector);
        vote(arb1, jobId, IArbitration.Outcome.Reject, 0);
        vm.expectRevert(IArbitration.AlreadyVoted.selector);
        vote(arb1, jobId, IArbitration.Outcome.Complete, FULL_BPS);
    }

    function test_vote_nonArbiterIsRefused() public {
        (uint256 jobId,) = _disputed(BUDGET);
        vm.expectRevert(IArbitration.NotAnArbiter.selector);
        vote(stranger, jobId, IArbitration.Outcome.Reject, 0);
    }

    function test_vote_rejectsMalformedResolutions() public {
        (uint256 jobId,) = _disputed(BUDGET);
        vm.expectRevert(IArbitration.BadResolution.selector);
        vote(arb1, jobId, IArbitration.Outcome.Complete, 0);
        vm.expectRevert(IArbitration.BadResolution.selector);
        vote(arb1, jobId, IArbitration.Outcome.Complete, FULL_BPS + 1);
        vm.expectRevert(IArbitration.BadResolution.selector);
        vote(arb1, jobId, IArbitration.Outcome.Reject, 1);
        vm.expectRevert(IArbitration.BadResolution.selector);
        vote(arb1, jobId, IArbitration.Outcome.Lapsed, FULL_BPS);
        vm.expectRevert(IArbitration.BadResolution.selector);
        vote(arb1, jobId, IArbitration.Outcome.None, 0);
    }

    function test_vote_unknownDispute() public {
        vm.expectRevert(IArbitration.UnknownDispute.selector);
        vote(arb1, 99, IArbitration.Outcome.Reject, 0);
    }

    function test_vote_competingResolutionsFirstToThresholdWins() public {
        (uint256 jobId, uint64 bond) = _disputed(BUDGET);
        vote(arb1, jobId, IArbitration.Outcome.Complete, FULL_BPS);
        vote(arb2, jobId, IArbitration.Outcome.Reject, 0);
        (IArbitration.Outcome outcome,,) = arbitration.decision(jobId);
        assertEq(uint8(outcome), uint8(IArbitration.Outcome.None), "1-1 is not a decision");

        bytes32 hash = arbitration.resolutionHash(jobId, IArbitration.Outcome.Reject, 0);
        vm.expectEmit(true, false, false, true);
        emit IArbitration.DecisionReached(jobId, uint8(IArbitration.Outcome.Reject), 0, hash);
        vote(arb3, jobId, IArbitration.Outcome.Reject, 0);

        assertEq(uint8(status(jobId)), uint8(ISquareJob.JobStatus.Rejected), "a rejection applies immediately");
        assertEq(kernel.withdrawable(client), BUDGET, "escrow refunded to the client");
        assertEq(kernel.withdrawable(provider), 0);
        assertEq(arbitration.withdrawable(client), bond, "the vindicated disputer gets the bond back");
        vm.expectRevert(IArbitration.AlreadyDecided.selector);
        vote(arb1, jobId, IArbitration.Outcome.Reject, 0);
        assertSolvent();
    }

    function test_decision_completeFavoursProviderAndAwardsTheBond() public {
        (uint256 jobId, uint64 bond) = _disputed(BUDGET);
        vote(arb1, jobId, IArbitration.Outcome.Complete, FULL_BPS);
        vote(arb2, jobId, IArbitration.Outcome.Complete, FULL_BPS);
        assertEq(uint8(status(jobId)), uint8(ISquareJob.JobStatus.Submitted), "completion waits for the proof");

        vm.expectRevert(IArbitration.NothingToSettle.selector);
        vm.prank(address(keeper));
        arbitration.settleBond(jobId);

        uint256 evaluatorFee = (BUDGET * EVALUATOR_FEE_BP) / FULL_BPS;
        vm.expectEmit(true, false, true, true);
        emit IKeeperEvaluator.DecisionApplied(jobId, uint8(IArbitration.Outcome.Complete), FULL_BPS, cranker, evaluatorFee);
        vm.prank(cranker);
        keeper.finalizeDecided(jobId, "");

        assertEq(uint8(status(jobId)), uint8(ISquareJob.JobStatus.Completed));
        assertEq(kernel.withdrawable(provider), netOf(BUDGET));
        assertEq(arbitration.withdrawable(provider), bond, "the defeated disputer's bond goes to the provider");
        assertEq(arbitration.withdrawable(client), 0);
        assertEq(usdc.balanceOf(cranker), evaluatorFee);
        vm.expectRevert(IKeeperEvaluator.AlreadyResolved.selector);
        keeper.finalizeDecided(jobId, "");
        assertSolvent();
    }

    function test_decision_splitRoutesThroughTheHookAndReturnsTheBond() public {
        (uint256 jobId, uint64 bond) = _disputed(BUDGET);
        vote(arb2, jobId, IArbitration.Outcome.Complete, 4_000);
        vote(arb3, jobId, IArbitration.Outcome.Complete, 4_000);
        vm.prank(cranker);
        keeper.finalizeDecided(jobId, "");

        uint256 net = netOf(BUDGET);
        uint256 providerShare = (net * 4_000) / FULL_BPS;
        assertEq(kernel.withdrawable(provider), providerShare);
        assertEq(kernel.withdrawable(client), net - providerShare);
        assertEq(record(jobId).providerBps, 4_000);
        assertEq(arbitration.withdrawable(client), bond, "a split returns the bond");
        assertEq(arbitration.withdrawable(provider), 0);
        assertSolvent();
    }

    function test_lapse_degradesToTheOptimisticOutcome() public {
        (uint256 jobId, uint64 bond) = _disputed(BUDGET);
        IArbitration.Dispute memory d = arbitration.disputeOf(jobId);
        vm.expectRevert(abi.encodeWithSelector(IArbitration.NotLapsed.selector, d.resolveBy));
        arbitration.lapse(jobId);

        vm.warp(d.resolveBy);
        vm.expectEmit(true, false, false, true);
        emit IArbitration.DisputeExpired(jobId);
        arbitration.lapse(jobId);
        vm.expectRevert(IArbitration.AlreadyDecided.selector);
        vote(arb1, jobId, IArbitration.Outcome.Reject, 0);

        vm.prank(cranker);
        keeper.finalizeDecided(jobId, "");
        assertEq(kernel.withdrawable(provider), netOf(BUDGET), "the provider is paid as if never disputed");
        assertEq(arbitration.withdrawable(client), bond, "no ruling, no penalty");
        assertLt(block.timestamp, record(jobId).expiredAt, "and it happens before claimRefund could");
        assertSolvent();
    }

    function test_rotation_keepsOpenDisputesOnTheirOwnSet() public {
        (uint256 jobId,) = _disputed(BUDGET);
        address arb4 = makeAddr("arb4");
        address[] memory next = new address[](2);
        next[0] = arb4;
        next[1] = stranger;
        vm.prank(owner);
        arbitration.setArbiters(next, 2);
        assertEq(arbitration.currentVersion(), 2);

        vm.expectRevert(IArbitration.NotAnArbiter.selector);
        vote(arb4, jobId, IArbitration.Outcome.Reject, 0);
        vote(arb1, jobId, IArbitration.Outcome.Reject, 0);
        vote(arb3, jobId, IArbitration.Outcome.Reject, 0);
        assertEq(uint8(status(jobId)), uint8(ISquareJob.JobStatus.Rejected));

        (uint256 later,) = _disputed(BUDGET);
        vm.expectRevert(IArbitration.NotAnArbiter.selector);
        vote(arb1, later, IArbitration.Outcome.Reject, 0);
        vote(arb4, later, IArbitration.Outcome.Reject, 0);
        vote(stranger, later, IArbitration.Outcome.Reject, 0);
        assertEq(uint8(status(later)), uint8(ISquareJob.JobStatus.Rejected));
    }

    function test_setArbiters_validation() public {
        address[] memory dup = new address[](2);
        dup[0] = arb1;
        dup[1] = arb1;
        vm.startPrank(owner);
        vm.expectRevert(IArbitration.BadArbiterSet.selector);
        arbitration.setArbiters(dup, 1);
        address[] memory one = new address[](1);
        one[0] = arb1;
        vm.expectRevert(IArbitration.BadArbiterSet.selector);
        arbitration.setArbiters(one, 2);
        vm.expectRevert(IArbitration.BadArbiterSet.selector);
        arbitration.setArbiters(one, 0);
        one[0] = address(0);
        vm.expectRevert(IArbitration.ZeroAddress.selector);
        arbitration.setArbiters(one, 1);
        vm.stopPrank();
        vm.expectRevert();
        vm.prank(stranger);
        arbitration.setArbiters(one, 1);
    }

    function test_settleBond_anyoneMayCallOnceTheStateDecides() public {
        (uint256 jobId, uint64 bond) = _disputed(BUDGET);
        vote(arb1, jobId, IArbitration.Outcome.Complete, FULL_BPS);
        vote(arb2, jobId, IArbitration.Outcome.Complete, FULL_BPS);
        vm.expectRevert(IArbitration.NothingToSettle.selector);
        vm.prank(stranger);
        arbitration.settleBond(jobId);
        vm.prank(cranker);
        keeper.finalizeDecided(jobId, "");
        assertEq(arbitration.withdrawable(provider), bond);
        vm.expectRevert(IArbitration.NothingToSettle.selector);
        vm.prank(stranger);
        arbitration.settleBond(jobId);
        vm.expectRevert(IArbitration.UnknownDispute.selector);
        arbitration.settleBond(99);
    }

    function test_settleBond_returnsTheBondWhenTheJobExpiresUnderADeadResolver() public {
        MaliciousHook rogue = new MaliciousHook(address(kernel));
        vm.prank(owner);
        kernel.setHookWhitelist(address(rogue), true);
        uint256 jobId = submittedJob(BUDGET, address(rogue));
        uint64 bond = arbitration.bondFor(uint64(BUDGET));
        vm.prank(client);
        keeper.dispute(jobId, keccak256("evidence"));
        rogue.setMode(MaliciousHook.Mode.ResolverReverts);
        vm.expectRevert(IArbitration.NothingToSettle.selector);
        arbitration.settleBond(jobId);
        vm.warp(expiry());
        arbitration.lapse(jobId);
        vm.expectRevert(MaliciousHook.HookSaysNo.selector);
        keeper.finalizeDecided(jobId, "");
        kernel.claimRefund(jobId);
        assertEq(uint8(status(jobId)), uint8(ISquareJob.JobStatus.Expired));
        vm.prank(stranger);
        arbitration.settleBond(jobId);
        assertEq(arbitration.withdrawable(client), bond, "a job that cannot complete gives the disputer the bond back");
        vm.expectRevert(IArbitration.NothingToSettle.selector);
        arbitration.settleBond(jobId);
        assertEq(usdc.balanceOf(address(arbitration)), bond);
        assertSolvent();
    }

    function test_bondWithdraw() public {
        (uint256 jobId, uint64 bond) = _disputed(BUDGET);
        vote(arb1, jobId, IArbitration.Outcome.Reject, 0);
        vote(arb2, jobId, IArbitration.Outcome.Reject, 0);
        uint256 before = usdc.balanceOf(client);
        vm.prank(client);
        arbitration.withdraw();
        assertEq(usdc.balanceOf(client), before + bond);
        vm.expectRevert(IArbitration.InsufficientBalance.selector);
        vm.prank(client);
        arbitration.withdrawTo(client, 1);
    }

    function test_griefing_frivolousDisputeCostsTheDisputer() public {
        (uint256 jobId, uint64 bond) = _disputed(BUDGET);
        assertEq(bond, 100 * USDC);
        uint256 clientBefore = usdc.balanceOf(client);
        vote(arb1, jobId, IArbitration.Outcome.Complete, FULL_BPS);
        vote(arb3, jobId, IArbitration.Outcome.Complete, FULL_BPS);
        vm.prank(cranker);
        keeper.finalizeDecided(jobId, "");
        vm.prank(provider);
        arbitration.withdraw();
        vm.prank(provider);
        kernel.withdraw();
        assertEq(usdc.balanceOf(provider), netOf(BUDGET) + bond);
        assertEq(usdc.balanceOf(client), clientBefore, "the bond is gone for good");
        assertEq(arbitration.withdrawable(client), 0);
    }

    function test_vote_splitNeedsAPayoutResolver() public {
        uint256 jobId = submittedJob(BUDGET, address(0));
        vm.prank(client);
        keeper.dispute(jobId, keccak256("evidence"));
        vm.expectRevert(IArbitration.SplitNeedsAPayoutResolver.selector);
        vote(arb1, jobId, IArbitration.Outcome.Complete, 4_000);
        vote(arb1, jobId, IArbitration.Outcome.Complete, FULL_BPS);
        vote(arb2, jobId, IArbitration.Outcome.Complete, FULL_BPS);
        vm.prank(cranker);
        keeper.finalizeDecided(jobId, "");
        assertEq(record(jobId).providerBps, FULL_BPS);
        assertEq(kernel.withdrawable(provider), netOf(BUDGET), "a hookless job can only be completed in full or rejected");
    }

    function test_settleBond_routesTheBondInAllFourOutcomes() public {
        (uint256 rejected, uint64 bond) = _disputed(BUDGET);
        vote(arb1, rejected, IArbitration.Outcome.Reject, 0);
        vote(arb2, rejected, IArbitration.Outcome.Reject, 0);
        assertEq(arbitration.withdrawable(client), bond, "reject: the disputer gets the bond back");

        (uint256 full,) = _disputed(BUDGET);
        vote(arb1, full, IArbitration.Outcome.Complete, FULL_BPS);
        vote(arb2, full, IArbitration.Outcome.Complete, FULL_BPS);
        vm.prank(cranker);
        keeper.finalizeDecided(full, "");
        assertEq(arbitration.withdrawable(provider), bond, "full completion: the payee takes the bond");
        assertEq(arbitration.withdrawable(client), bond, "the client lost this one");

        (uint256 split,) = _disputed(BUDGET);
        vote(arb1, split, IArbitration.Outcome.Complete, 4_000);
        vote(arb2, split, IArbitration.Outcome.Complete, 4_000);
        vm.prank(cranker);
        keeper.finalizeDecided(split, "");
        assertEq(arbitration.withdrawable(client), 2 * bond, "split: the bond returns to the disputer");

        (uint256 lapsed,) = _disputed(BUDGET);
        vm.warp(arbitration.disputeOf(lapsed).resolveBy);
        arbitration.lapse(lapsed);
        vm.prank(cranker);
        keeper.finalizeDecided(lapsed, "");
        assertEq(arbitration.withdrawable(client), 3 * bond, "lapsed: the bond returns to the disputer");
        assertEq(arbitration.withdrawable(provider), bond, "the provider never posts a bond and takes one only on a full win");
        assertSolvent();
    }
}
