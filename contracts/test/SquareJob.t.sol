// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {ISquareJob} from "../src/interfaces/ISquareJob.sol";
import {IACPHook} from "../src/interfaces/IACPHook.sol";
import {MaliciousHook} from "./mocks/MaliciousHook.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract SquareJobTest is BaseTest {
    uint256 internal constant BUDGET = 1_000 * USDC;

    function test_createJob_storesRecordAndEmitsBothEvents() public {
        uint256 deadline = expiry();
        vm.expectEmit(true, true, true, true);
        emit ISquareJob.JobCreated(1, client, provider, address(keeper), deadline, address(hook));
        vm.expectEmit(true, true, true, true);
        emit ISquareJob.JobDescribed(1, uint48(block.timestamp), "spec:0xabc");
        vm.prank(client);
        uint256 jobId = kernel.createJob(provider, address(keeper), deadline, "spec:0xabc", address(hook));

        assertEq(jobId, 1);
        ISquareJob.JobRecord memory job = record(jobId);
        assertEq(job.client, client);
        assertEq(job.provider, provider);
        assertEq(job.evaluator, address(keeper));
        assertEq(job.expiredAt, deadline);
        assertEq(job.createdAt, block.timestamp);
        assertEq(job.hook, address(hook));
        assertTrue(job.hookResolvesPayout);
        assertEq(uint8(job.status), uint8(ISquareJob.JobStatus.Open));

        ISquareJob.Job memory view_ = kernel.getJob(jobId);
        assertEq(view_.id, 1);
        assertEq(view_.description, "spec:0xabc");
        assertEq(view_.budget, 0);
    }

    function test_createJob_revertsOnZeroEvaluator() public {
        vm.expectRevert(ISquareJob.ZeroAddress.selector);
        vm.prank(client);
        kernel.createJob(provider, address(0), expiry(), "", address(0));
    }

    function test_createJob_revertsOnPastExpiry() public {
        vm.expectRevert(ISquareJob.ExpiryInPast.selector);
        vm.prank(client);
        kernel.createJob(provider, address(keeper), block.timestamp, "", address(0));
    }

    function test_createJob_revertsOnNonWhitelistedHook() public {
        MaliciousHook rogue = new MaliciousHook(address(kernel));
        vm.expectRevert(abi.encodeWithSelector(ISquareJob.HookNotWhitelisted.selector, address(rogue)));
        vm.prank(client);
        kernel.createJob(provider, address(keeper), expiry(), "", address(rogue));
    }

    function test_createJob_revertsOnWhitelistedNonHook() public {
        vm.prank(owner);
        kernel.setHookWhitelist(address(usdc), true);
        vm.expectRevert(abi.encodeWithSelector(ISquareJob.InvalidHook.selector, address(usdc)));
        vm.prank(client);
        kernel.createJob(provider, address(keeper), expiry(), "", address(usdc));
    }

    function test_createJob_noHookCanBeDisabled() public {
        vm.prank(owner);
        kernel.setHookWhitelist(address(0), false);
        vm.expectRevert(abi.encodeWithSelector(ISquareJob.HookNotWhitelisted.selector, address(0)));
        vm.prank(client);
        kernel.createJob(provider, address(keeper), expiry(), "", address(0));
    }

    function test_createJob_enforcesSettlementHorizonOfEvaluator() public {
        uint256 horizon = keeper.settlementHorizon();
        assertEq(horizon, CHALLENGE_WINDOW + DISPUTE_WINDOW);
        vm.expectRevert(abi.encodeWithSelector(ISquareJob.ExpiryTooShort.selector, block.timestamp + horizon));
        vm.prank(client);
        kernel.createJob(provider, address(keeper), block.timestamp + horizon - 1, "", address(0));

        vm.prank(client);
        kernel.createJob(provider, address(keeper), block.timestamp + horizon, "", address(0));
    }

    function test_createJob_eoaEvaluatorHasNoHorizon() public {
        vm.prank(client);
        uint256 jobId = kernel.createJob(provider, client, block.timestamp + 1, "", address(0));
        assertEq(record(jobId).evaluator, client);
    }

    function test_createJob_providerMayBeZeroThenSet() public {
        vm.prank(client);
        uint256 jobId = kernel.createJob(address(0), address(keeper), expiry(), "", address(0));
        vm.prank(client);
        kernel.setBudget(jobId, BUDGET, "");
        vm.expectRevert(ISquareJob.ProviderNotSet.selector);
        vm.prank(client);
        kernel.fund(jobId, BUDGET, "");

        vm.expectRevert(ISquareJob.Unauthorized.selector);
        vm.prank(stranger);
        kernel.setProvider(jobId, provider, "");
        vm.expectEmit(true, true, false, true);
        emit ISquareJob.ProviderSet(jobId, provider);
        vm.prank(client);
        kernel.setProvider(jobId, provider, "");
        vm.expectRevert(ISquareJob.ProviderAlreadySet.selector);
        vm.prank(client);
        kernel.setProvider(jobId, stranger, "");
    }

    function test_setBudget_clientOrProviderOnlyWhileOpen() public {
        uint256 jobId = createJob(BUDGET, address(0));
        vm.prank(client);
        kernel.setBudget(jobId, 2 * BUDGET, "");
        assertEq(record(jobId).budget, 2 * BUDGET);
        vm.expectRevert(ISquareJob.Unauthorized.selector);
        vm.prank(stranger);
        kernel.setBudget(jobId, 1, "");
        vm.expectRevert(ISquareJob.BudgetTooLarge.selector);
        vm.prank(client);
        kernel.setBudget(jobId, uint256(type(uint64).max) + 1, "");
        vm.prank(client);
        kernel.fund(jobId, 2 * BUDGET, "");
        vm.expectRevert(ISquareJob.WrongStatus.selector);
        vm.prank(client);
        kernel.setBudget(jobId, 1, "");
    }

    function test_fund_pullsTokensSnapshotsFeesAndGuardsAgainstFrontRunning() public {
        uint256 jobId = createJob(BUDGET, address(0));
        vm.expectRevert(ISquareJob.BudgetMismatch.selector);
        vm.prank(client);
        kernel.fund(jobId, BUDGET + 1, "");
        vm.expectRevert(ISquareJob.Unauthorized.selector);
        vm.prank(provider);
        kernel.fund(jobId, BUDGET, "");

        uint256 before = usdc.balanceOf(client);
        vm.expectEmit(true, true, false, true);
        emit ISquareJob.JobFunded(jobId, client, BUDGET);
        vm.expectEmit(true, false, false, true);
        emit ISquareJob.FeesSnapshotted(jobId, PLATFORM_FEE_BP, EVALUATOR_FEE_BP, uint48(block.timestamp));
        vm.prank(client);
        kernel.fund(jobId, BUDGET, "");

        assertEq(usdc.balanceOf(client), before - BUDGET);
        assertEq(usdc.balanceOf(address(kernel)), BUDGET);
        ISquareJob.JobRecord memory job = record(jobId);
        assertEq(uint8(job.status), uint8(ISquareJob.JobStatus.Funded));
        assertEq(job.platformFeeBP, PLATFORM_FEE_BP);
        assertEq(job.evaluatorFeeBP, EVALUATOR_FEE_BP);
        assertEq(job.fundedAt, block.timestamp);

        vm.prank(owner);
        kernel.setFees(500, 500, treasury);
        assertEq(kernel.netPayout(jobId), netOf(BUDGET), "fee snapshot must survive an admin change");
        assertSolvent();
    }

    function test_fund_revertsOnZeroBudgetAndAfterExpiry() public {
        vm.prank(client);
        uint256 jobId = kernel.createJob(provider, address(keeper), expiry(), "", address(0));
        vm.expectRevert(ISquareJob.ZeroBudget.selector);
        vm.prank(client);
        kernel.fund(jobId, 0, "");
        vm.prank(client);
        kernel.setBudget(jobId, BUDGET, "");
        vm.warp(expiry());
        vm.expectRevert(ISquareJob.PastExpiry.selector);
        vm.prank(client);
        kernel.fund(jobId, BUDGET, "");
    }

    function test_submit_recordsDeliverableAndTimestamp() public {
        uint256 jobId = fundedJob(BUDGET, address(0));
        vm.expectRevert(ISquareJob.Unauthorized.selector);
        vm.prank(client);
        kernel.submit(jobId, DELIVERABLE, "");

        vm.expectEmit(true, true, false, true);
        emit ISquareJob.JobSubmitted(jobId, provider, DELIVERABLE);
        vm.expectEmit(true, false, false, true);
        emit ISquareJob.SubmissionTimed(jobId, uint48(block.timestamp), uint48(expiry()));
        vm.prank(provider);
        kernel.submit(jobId, DELIVERABLE, "");
        ISquareJob.JobRecord memory job = record(jobId);
        assertEq(uint8(job.status), uint8(ISquareJob.JobStatus.Submitted));
        assertEq(job.deliverable, DELIVERABLE);
        assertEq(job.submittedAt, block.timestamp);
    }

    function test_submit_revertsWhenExpiryCannotCoverTheSettlementHorizon() public {
        uint256 jobId = fundedJob(BUDGET, address(0));
        uint256 horizon = keeper.settlementHorizon();
        vm.warp(expiry() - horizon + 1);
        vm.expectRevert(abi.encodeWithSelector(ISquareJob.ExpiryTooShort.selector, block.timestamp + horizon));
        vm.prank(provider);
        kernel.submit(jobId, DELIVERABLE, "");
    }

    function test_submit_revertsAfterExpiry() public {
        uint256 jobId = fundedJob(BUDGET, address(0));
        vm.warp(expiry());
        vm.expectRevert(ISquareJob.PastExpiry.selector);
        vm.prank(provider);
        kernel.submit(jobId, DELIVERABLE, "");
    }

    function test_complete_onlyEvaluatorOnlySubmitted() public {
        uint256 jobId = fundedJob(BUDGET, address(0));
        vm.expectRevert(ISquareJob.WrongStatus.selector);
        vm.prank(address(keeper));
        kernel.complete(jobId, bytes32(0), "");
        vm.prank(provider);
        kernel.submit(jobId, DELIVERABLE, "");
        vm.expectRevert(ISquareJob.Unauthorized.selector);
        vm.prank(client);
        kernel.complete(jobId, bytes32(0), "");
    }

    function test_complete_creditsLedgerInsteadOfPushing() public {
        uint256 jobId = submittedJob(BUDGET, address(0));
        uint256 platformFee = (BUDGET * PLATFORM_FEE_BP) / FULL_BPS;
        uint256 evaluatorFee = (BUDGET * EVALUATOR_FEE_BP) / FULL_BPS;
        uint256 net = BUDGET - platformFee - evaluatorFee;

        vm.expectEmit(true, true, false, true);
        emit ISquareJob.PaymentReleased(jobId, provider, net);
        vm.expectEmit(true, true, false, true);
        emit ISquareJob.PayoutRouted(jobId, provider, FULL_BPS, net, 0);
        vm.prank(address(keeper));
        kernel.complete(jobId, keccak256("reason"), "");

        assertEq(usdc.balanceOf(provider), 0, "nothing is pushed");
        assertEq(kernel.withdrawable(provider), net);
        assertEq(kernel.withdrawable(treasury), platformFee);
        assertEq(kernel.withdrawable(address(keeper)), evaluatorFee);
        assertEq(kernel.totalWithdrawable(), BUDGET);
        assertEq(record(jobId).payee, provider);
        assertEq(record(jobId).providerBps, FULL_BPS);
        assertSolvent();

        vm.prank(provider);
        kernel.withdraw();
        assertEq(usdc.balanceOf(provider), net);
        assertEq(kernel.withdrawable(provider), 0);
        assertEq(kernel.totalWithdrawable(), BUDGET - net);
        assertSolvent();
    }

    function test_withdraw_blocklistedRecipientCanRedirect() public {
        uint256 jobId = submittedJob(BUDGET, address(0));
        vm.prank(address(keeper));
        kernel.complete(jobId, bytes32(0), "");
        usdc.setBlocklisted(provider, true);

        vm.expectRevert(bytes("USDC: blocklisted"));
        vm.prank(provider);
        kernel.withdraw();
        assertEq(kernel.withdrawable(provider), netOf(BUDGET), "a failed withdrawal leaves the credit intact");

        address fresh = makeAddr("fresh");
        vm.prank(provider);
        kernel.withdrawTo(fresh, netOf(BUDGET));
        assertEq(usdc.balanceOf(fresh), netOf(BUDGET));
    }

    function test_withdrawTo_revertsOnOverdrawAndZeroAddress() public {
        vm.expectRevert(ISquareJob.InsufficientBalance.selector);
        vm.prank(provider);
        kernel.withdrawTo(provider, 1);
        vm.expectRevert(ISquareJob.ZeroAddress.selector);
        vm.prank(provider);
        kernel.withdrawTo(address(0), 0);
    }

    function test_reject_clientWhileOpenNoRefundNeeded() public {
        uint256 jobId = createJob(BUDGET, address(0));
        vm.expectRevert(ISquareJob.Unauthorized.selector);
        vm.prank(provider);
        kernel.reject(jobId, bytes32(0), "");
        vm.expectEmit(true, true, false, true);
        emit ISquareJob.JobRejected(jobId, client, keccak256("cancel"));
        vm.prank(client);
        kernel.reject(jobId, keccak256("cancel"), "");
        assertEq(uint8(status(jobId)), uint8(ISquareJob.JobStatus.Rejected));
        assertEq(kernel.totalWithdrawable(), 0);
    }

    function test_reject_evaluatorWhileFundedOrSubmittedRefundsClient() public {
        uint256 jobId = fundedJob(BUDGET, address(0));
        vm.expectRevert(ISquareJob.Unauthorized.selector);
        vm.prank(client);
        kernel.reject(jobId, bytes32(0), "");
        vm.expectEmit(true, true, false, true);
        emit ISquareJob.Refunded(jobId, client, BUDGET);
        vm.prank(address(keeper));
        kernel.reject(jobId, bytes32(0), "");
        assertEq(kernel.withdrawable(client), BUDGET);
        assertSolvent();

        uint256 second = submittedJob(BUDGET, address(0));
        vm.prank(address(keeper));
        kernel.reject(second, bytes32(0), "");
        assertEq(kernel.withdrawable(client), 2 * BUDGET);
        assertEq(uint8(status(second)), uint8(ISquareJob.JobStatus.Rejected));
        vm.expectRevert(ISquareJob.WrongStatus.selector);
        vm.prank(address(keeper));
        kernel.reject(second, bytes32(0), "");
    }

    function test_claimRefund_anyoneAfterExpiryFromFundedOrSubmitted() public {
        uint256 funded = fundedJob(BUDGET, address(0));
        uint256 submitted = submittedJob(BUDGET, address(0));
        vm.expectRevert(ISquareJob.NotExpired.selector);
        kernel.claimRefund(funded);
        vm.warp(expiry());
        vm.expectEmit(true, false, false, true);
        emit ISquareJob.JobExpired(funded);
        vm.prank(stranger);
        kernel.claimRefund(funded);
        vm.prank(stranger);
        kernel.claimRefund(submitted);
        assertEq(kernel.withdrawable(client), 2 * BUDGET);
        assertEq(uint8(status(funded)), uint8(ISquareJob.JobStatus.Expired));
        assertEq(uint8(status(submitted)), uint8(ISquareJob.JobStatus.Expired));
        vm.expectRevert(ISquareJob.WrongStatus.selector);
        kernel.claimRefund(funded);
        assertSolvent();
    }

    function test_claimRefund_revertsWhileOpen() public {
        uint256 jobId = createJob(BUDGET, address(0));
        vm.warp(expiry());
        vm.expectRevert(ISquareJob.WrongStatus.selector);
        kernel.claimRefund(jobId);
    }

    function _rogueJob(MaliciousHook rogue) internal returns (uint256 jobId) {
        vm.prank(owner);
        kernel.setHookWhitelist(address(rogue), true);
        jobId = submittedJob(BUDGET, address(rogue));
    }

    function test_hook_receivesSelectorAndSpecEncodedData() public {
        MaliciousHook rogue = new MaliciousHook(address(kernel));
        vm.prank(owner);
        kernel.setHookWhitelist(address(rogue), true);
        vm.prank(client);
        uint256 jobId = kernel.createJob(address(0), address(keeper), expiry(), "", address(rogue));

        bytes memory optParams = hex"c0ffee";
        vm.expectCall(
            address(rogue),
            abi.encodeCall(IACPHook.beforeAction, (jobId, ISquareJob.setProvider.selector, abi.encode(provider, optParams)))
        );
        vm.expectCall(
            address(rogue),
            abi.encodeCall(IACPHook.afterAction, (jobId, ISquareJob.setProvider.selector, abi.encode(provider, optParams)))
        );
        vm.prank(client);
        kernel.setProvider(jobId, provider, optParams);

        vm.expectCall(
            address(rogue),
            abi.encodeCall(IACPHook.beforeAction, (jobId, ISquareJob.setBudget.selector, abi.encode(BUDGET, optParams)))
        );
        vm.prank(client);
        kernel.setBudget(jobId, BUDGET, optParams);

        vm.expectCall(address(rogue), abi.encodeCall(IACPHook.beforeAction, (jobId, ISquareJob.fund.selector, optParams)));
        vm.prank(client);
        kernel.fund(jobId, BUDGET, optParams);

        vm.expectCall(
            address(rogue),
            abi.encodeCall(IACPHook.beforeAction, (jobId, ISquareJob.submit.selector, abi.encode(DELIVERABLE, optParams)))
        );
        vm.prank(provider);
        kernel.submit(jobId, DELIVERABLE, optParams);

        bytes32 reason = keccak256("done");
        vm.expectCall(
            address(rogue),
            abi.encodeCall(IACPHook.afterAction, (jobId, ISquareJob.complete.selector, abi.encode(reason, optParams)))
        );
        vm.prank(address(keeper));
        kernel.complete(jobId, reason, optParams);
        assertEq(rogue.calls(), 10);
    }

    function test_hook_reentrantCompleteIsBlocked() public {
        MaliciousHook rogue = new MaliciousHook(address(kernel));
        uint256 jobId = _rogueJob(rogue);
        rogue.setMode(MaliciousHook.Mode.ReenterComplete);
        vm.prank(address(keeper));
        kernel.complete(jobId, bytes32(0), "");
        assertEq(rogue.lastReentryError(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
        assertEq(kernel.withdrawable(provider), netOf(BUDGET), "paid exactly once");
        assertSolvent();
    }

    function test_hook_reentrantWithdrawIsBlocked() public {
        MaliciousHook rogue = new MaliciousHook(address(kernel));
        uint256 jobId = _rogueJob(rogue);
        rogue.setMode(MaliciousHook.Mode.ReenterWithdraw);
        vm.prank(address(keeper));
        kernel.complete(jobId, bytes32(0), "");
        assertEq(rogue.lastReentryError(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
        assertSolvent();
    }

    function test_hook_reentrantClaimRefundIsBlocked() public {
        MaliciousHook rogue = new MaliciousHook(address(kernel));
        uint256 jobId = _rogueJob(rogue);
        rogue.setMode(MaliciousHook.Mode.ReenterClaimRefund);
        vm.warp(expiry());
        vm.prank(address(keeper));
        kernel.reject(jobId, bytes32(0), "");
        assertEq(rogue.lastReentryError(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
        assertEq(kernel.withdrawable(client), BUDGET, "refunded exactly once");
        assertSolvent();
    }

    function test_hook_revertBubblesTheHooksOwnError() public {
        MaliciousHook rogue = new MaliciousHook(address(kernel));
        uint256 jobId = _rogueJob(rogue);
        rogue.setMode(MaliciousHook.Mode.Revert);
        vm.expectRevert(MaliciousHook.HookSaysNo.selector);
        vm.prank(address(keeper));
        kernel.complete(jobId, bytes32(0), "");
        assertEq(uint8(status(jobId)), uint8(ISquareJob.JobStatus.Submitted), "a reverting hook blocks the action");
    }

    function test_hook_outOfGasIsBoundedByTheLimit() public {
        MaliciousHook rogue = new MaliciousHook(address(kernel));
        uint256 jobId = _rogueJob(rogue);
        rogue.setMode(MaliciousHook.Mode.Loop);
        uint256 gasBefore = gasleft();
        vm.expectRevert(abi.encodeWithSelector(ISquareJob.HookReverted.selector, address(rogue)));
        vm.prank(address(keeper));
        kernel.complete{gas: 3_000_000}(jobId, bytes32(0), "");
        assertLt(gasBefore - gasleft(), 3_100_000, "the loop could not consume more than the forwarded limit");
    }

    function test_hook_claimRefundIsNeverHooked() public {
        MaliciousHook rogue = new MaliciousHook(address(kernel));
        uint256 jobId = _rogueJob(rogue);
        rogue.setMode(MaliciousHook.Mode.Revert);
        vm.warp(expiry());
        uint256 callsBefore = rogue.calls();
        kernel.claimRefund(jobId);
        assertEq(rogue.calls(), callsBefore, "no hook call on the refund path");
        assertEq(kernel.withdrawable(client), BUDGET);
    }

    function test_resolver_zeroPayeeAndBadSplitAreRejectedByTheKernel() public {
        MaliciousHook rogue = new MaliciousHook(address(kernel));
        uint256 jobId = _rogueJob(rogue);
        rogue.setMode(MaliciousHook.Mode.BadPayee);
        vm.expectRevert(ISquareJob.InvalidPayee.selector);
        vm.prank(address(keeper));
        kernel.complete(jobId, bytes32(0), "");
        rogue.setMode(MaliciousHook.Mode.BadSplit);
        vm.expectRevert(ISquareJob.InvalidSplit.selector);
        vm.prank(address(keeper));
        kernel.complete(jobId, bytes32(0), "");
    }

    function test_resolver_whitelistedHookDecidesThePayee() public {
        MaliciousHook rogue = new MaliciousHook(address(kernel));
        uint256 jobId = _rogueJob(rogue);
        rogue.setMode(MaliciousHook.Mode.StealPayout);
        rogue.setThief(stranger);
        vm.prank(address(keeper));
        kernel.complete(jobId, bytes32(0), "");
        assertEq(kernel.withdrawable(stranger), netOf(BUDGET));
        assertEq(kernel.withdrawable(provider), 0);
        assertSolvent();
    }

    function test_setFees_capAndOwnerOnly() public {
        vm.expectRevert();
        vm.prank(stranger);
        kernel.setFees(1, 1, treasury);
        vm.expectRevert(ISquareJob.FeesTooHigh.selector);
        vm.prank(owner);
        kernel.setFees(1_500, 600, treasury);
        vm.expectRevert(ISquareJob.ZeroAddress.selector);
        vm.prank(owner);
        kernel.setFees(1, 1, address(0));
        vm.prank(owner);
        kernel.setFees(200, 100, stranger);
        assertEq(kernel.platformFeeBP(), 200);
        assertEq(kernel.evaluatorFeeBP(), 100);
        assertEq(kernel.platformTreasury(), stranger);
    }

    function test_getJob_revertsOnUnknownJob() public {
        vm.expectRevert(ISquareJob.InvalidJob.selector);
        kernel.getJob(42);
    }

    function testFuzz_completeConservesValue(uint64 budget, uint16 providerBps) public {
        budget = uint64(bound(budget, 1, 1_000_000_000 * USDC));
        providerBps = uint16(bound(providerBps, 0, FULL_BPS));
        usdc.mint(client, budget);
        MaliciousHook splitter = new MaliciousHook(address(kernel));
        vm.prank(owner);
        kernel.setHookWhitelist(address(splitter), true);
        uint256 jobId = submittedJob(budget, address(splitter));
        vm.mockCall(
            address(splitter),
            abi.encodeWithSelector(splitter.resolvePayout.selector),
            abi.encode(provider, providerBps)
        );
        vm.prank(address(keeper));
        kernel.complete(jobId, bytes32(0), "");

        uint256 platformFee = (uint256(budget) * PLATFORM_FEE_BP) / FULL_BPS;
        uint256 evaluatorFee = (uint256(budget) * EVALUATOR_FEE_BP) / FULL_BPS;
        uint256 net = budget - platformFee - evaluatorFee;
        uint256 providerShare = (net * providerBps) / FULL_BPS;
        assertEq(kernel.withdrawable(provider), providerShare);
        assertEq(kernel.withdrawable(client), net - providerShare);
        assertEq(kernel.withdrawable(treasury), platformFee);
        assertEq(kernel.withdrawable(address(keeper)), evaluatorFee);
        assertEq(kernel.totalWithdrawable(), budget, "every base unit is accounted for");
        assertSolvent();
    }
}
