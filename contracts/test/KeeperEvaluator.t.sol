// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {ISquareJob} from "../src/interfaces/ISquareJob.sol";
import {IKeeperEvaluator} from "../src/interfaces/IKeeperEvaluator.sol";
import {ISettlementHorizon} from "../src/interfaces/ISettlementHorizon.sol";
import {IArbitration} from "../src/interfaces/IArbitration.sol";
import {KeeperEvaluator} from "../src/KeeperEvaluator.sol";

contract KeeperEvaluatorTest is BaseTest {
    uint256 internal constant BUDGET = 1_000 * USDC;

    function test_declaresTheSettlementHorizon() public view {
        assertTrue(keeper.supportsInterface(type(ISettlementHorizon).interfaceId));
        assertEq(keeper.settlementHorizon(), CHALLENGE_WINDOW + DISPUTE_WINDOW);
    }

    function test_finalize_revertsWhileTheWindowIsOpen() public {
        uint256 jobId = submittedHookedJob(BUDGET);
        uint48 end = keeper.challengeEndsAt(jobId);
        assertEq(end, block.timestamp + CHALLENGE_WINDOW);
        vm.expectRevert(abi.encodeWithSelector(IKeeperEvaluator.WindowOpen.selector, end));
        vm.prank(cranker);
        keeper.finalize(jobId, "");
        vm.warp(end - 1);
        vm.expectRevert(abi.encodeWithSelector(IKeeperEvaluator.WindowOpen.selector, end));
        vm.prank(cranker);
        keeper.finalize(jobId, "");
    }

    function test_finalize_isPermissionlessAndPaysTheCaller() public {
        uint256 jobId = submittedHookedJob(BUDGET);
        pastWindow(jobId);
        uint256 evaluatorFee = (BUDGET * EVALUATOR_FEE_BP) / FULL_BPS;
        bytes32 reason = keeper.finalizeReason(jobId, DELIVERABLE);

        vm.expectEmit(true, true, false, true);
        emit ISquareJob.JobCompleted(jobId, address(keeper), reason);
        vm.expectEmit(true, true, false, true);
        emit IKeeperEvaluator.Finalized(jobId, cranker, evaluatorFee);
        vm.prank(cranker);
        keeper.finalize(jobId, "");

        assertEq(uint8(status(jobId)), uint8(ISquareJob.JobStatus.Completed));
        assertEq(usdc.balanceOf(cranker), evaluatorFee, "the keeper that paid the gas holds the fee");
        assertEq(kernel.withdrawable(address(keeper)), 0, "nothing accumulates on the evaluator");
        assertEq(kernel.withdrawable(provider), netOf(BUDGET));
        assertSolvent();
    }

    function test_finalize_twiceReverts() public {
        uint256 jobId = submittedHookedJob(BUDGET);
        pastWindow(jobId);
        keeper.finalize(jobId, "");
        vm.expectRevert(IKeeperEvaluator.NotSubmitted.selector);
        keeper.finalize(jobId, "");
    }

    function test_finalize_refusesJobsWithAnotherEvaluator() public {
        vm.prank(client);
        uint256 jobId = kernel.createJob(provider, client, expiry(), "", address(0));
        vm.expectRevert(IKeeperEvaluator.NotOurJob.selector);
        keeper.finalize(jobId, "");
    }

    function test_claimRefund_cannotRaceAFinalizableJob() public {
        uint256 jobId = submittedHookedJob(BUDGET);
        pastWindow(jobId);
        vm.expectRevert(ISquareJob.NotExpired.selector);
        kernel.claimRefund(jobId);
        vm.warp(block.timestamp + DISPUTE_WINDOW);
        vm.expectRevert(ISquareJob.NotExpired.selector);
        kernel.claimRefund(jobId);
        vm.prank(cranker);
        keeper.finalize(jobId, "");
        assertEq(uint8(status(jobId)), uint8(ISquareJob.JobStatus.Completed));
    }

    function test_expiryInvariant_holdsForTheLatestPossibleSubmission() public {
        uint256 jobId = fundedJob(BUDGET, address(hook));
        uint256 horizon = keeper.settlementHorizon();
        vm.warp(expiry() - horizon);
        vm.prank(provider);
        kernel.submit(jobId, DELIVERABLE, abi.encode(AGENT_ID, REQUEST_HASH));
        ISquareJob.JobRecord memory job = record(jobId);
        assertGe(job.expiredAt, job.submittedAt + CHALLENGE_WINDOW + DISPUTE_WINDOW);

        vm.prank(client);
        keeper.dispute(jobId, keccak256("evidence"));
        IArbitration.Dispute memory d = arbitration.disputeOf(jobId);
        assertLe(d.resolveBy, job.expiredAt, "arbitration always has time before claimRefund opens");
    }

    function test_dispute_onlyClientOnlyInsideTheWindow() public {
        uint256 jobId = submittedHookedJob(BUDGET);
        vm.expectRevert(IKeeperEvaluator.OnlyClient.selector);
        vm.prank(provider);
        keeper.dispute(jobId, bytes32(0));

        uint48 end = keeper.challengeEndsAt(jobId);
        vm.warp(end);
        vm.expectRevert(abi.encodeWithSelector(IKeeperEvaluator.WindowClosed.selector, end));
        vm.prank(client);
        keeper.dispute(jobId, bytes32(0));
    }

    function test_dispute_pullsTheBondAndBlocksFinalize() public {
        uint256 jobId = submittedHookedJob(BUDGET);
        uint64 bond = arbitration.bondFor(uint64(BUDGET));
        assertEq(bond, (BUDGET * BOND_BPS) / FULL_BPS);
        uint256 before = usdc.balanceOf(client);

        vm.expectEmit(true, true, false, true);
        emit IKeeperEvaluator.DisputeRaised(jobId, client, uint48(block.timestamp), keeper.challengeEndsAt(jobId));
        vm.prank(client);
        keeper.dispute(jobId, keccak256("evidence"));

        assertEq(usdc.balanceOf(client), before - bond);
        assertEq(usdc.balanceOf(address(arbitration)), bond);
        assertTrue(keeper.isDisputed(jobId));
        vm.expectRevert(IKeeperEvaluator.Disputed.selector);
        vm.prank(client);
        keeper.dispute(jobId, bytes32(0));

        pastWindow(jobId);
        vm.expectRevert(IKeeperEvaluator.Disputed.selector);
        keeper.finalize(jobId, "");
        assertEq(uint8(status(jobId)), uint8(ISquareJob.JobStatus.Submitted), "a dispute does not change status");
    }

    function test_dispute_requiresArbitrationToBeConfigured() public {
        KeeperEvaluator bare = new KeeperEvaluator(address(kernel), owner, CHALLENGE_WINDOW, DISPUTE_WINDOW);
        vm.prank(client);
        uint256 jobId = kernel.createJob(provider, address(bare), expiry(), "", address(0));
        vm.prank(client);
        kernel.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        kernel.fund(jobId, BUDGET, "");
        vm.prank(provider);
        kernel.submit(jobId, DELIVERABLE, "");
        vm.expectRevert(IKeeperEvaluator.ArbitrationNotSet.selector);
        vm.prank(client);
        bare.dispute(jobId, bytes32(0));
    }

    function test_finalizeDecided_requiresADecision() public {
        uint256 jobId = submittedHookedJob(BUDGET);
        vm.expectRevert(IKeeperEvaluator.NotDisputed.selector);
        keeper.finalizeDecided(jobId, "");
        vm.prank(client);
        keeper.dispute(jobId, bytes32(0));
        vm.expectRevert(IKeeperEvaluator.NotDecided.selector);
        keeper.finalizeDecided(jobId, "");
    }

    function test_applyRejection_onlyArbitration() public {
        uint256 jobId = submittedHookedJob(BUDGET);
        vm.expectRevert(IKeeperEvaluator.OnlyArbitration.selector);
        vm.prank(stranger);
        keeper.applyRejection(jobId, bytes32(0));
    }

    function test_configureWindows_doesNotTouchJobsAlreadyInTheirWindow() public {
        uint256 jobId = submittedHookedJob(BUDGET);
        uint48 originalEnd = keeper.challengeEndsAt(jobId);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(owner);
        keeper.configureWindows(1 hours, 1 days);
        assertEq(keeper.challengeEndsAt(jobId), originalEnd, "in-flight job keeps its window");
        assertEq(keeper.settlementHorizon(), 1 hours + 1 days, "new jobs see the new horizon");

        uint256 later = submittedHookedJob(BUDGET);
        assertEq(keeper.challengeEndsAt(later), block.timestamp + 1 hours);
    }

    function test_configureWindows_rejectsZeroAndNonOwner() public {
        vm.expectRevert(IKeeperEvaluator.ZeroWindow.selector);
        vm.prank(owner);
        keeper.configureWindows(0, 1 days);
        vm.expectRevert();
        vm.prank(stranger);
        keeper.configureWindows(1 hours, 1 days);
    }

    function test_setArbitration_onlyOnce() public {
        vm.expectRevert(IKeeperEvaluator.ArbitrationAlreadySet.selector);
        vm.prank(owner);
        keeper.setArbitration(stranger);
    }

    function test_gas_finalizeWithHook() public {
        uint256 jobId = submittedHookedJob(BUDGET);
        pastWindow(jobId);
        vm.prank(cranker);
        uint256 before = gasleft();
        keeper.finalize(jobId, "");
        uint256 used = before - gasleft();
        emit log_named_uint("finalize gas (hooked, reputation + validation written)", used);
        assertLt(used, 600_000);
    }
}
