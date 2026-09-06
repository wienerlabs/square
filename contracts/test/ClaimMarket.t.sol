// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {ISquareJob} from "../src/interfaces/ISquareJob.sol";
import {IClaimMarket} from "../src/interfaces/IClaimMarket.sol";
import {IArbitration} from "../src/interfaces/IArbitration.sol";
import {MockReputationRegistry} from "./mocks/MockRegistries.sol";

contract ClaimMarketTest is BaseTest {
    uint256 internal constant BUDGET = 1_000 * USDC;
    uint64 internal constant PRICE = uint64(900 * USDC);

    function _listed() internal returns (uint256 jobId) {
        jobId = submittedHookedJob(BUDGET);
        vm.prank(provider);
        market.list(jobId, PRICE);
    }

    function _sold() internal returns (uint256 jobId) {
        jobId = _listed();
        vm.prank(buyer);
        market.buy(jobId);
    }

    function test_list_onlyProviderOnlySubmittedOnlyOptimistic() public {
        uint256 funded = fundedJob(BUDGET, address(hook));
        vm.expectRevert(IClaimMarket.NotSubmitted.selector);
        vm.prank(provider);
        market.list(funded, PRICE);

        uint256 jobId = submittedHookedJob(BUDGET);
        vm.expectRevert(IClaimMarket.OnlyProvider.selector);
        vm.prank(client);
        market.list(jobId, PRICE);

        vm.prank(client);
        uint256 direct = kernel.createJob(provider, client, expiry(), "", address(0));
        vm.prank(client);
        kernel.setBudget(direct, BUDGET, "");
        vm.prank(client);
        kernel.fund(direct, BUDGET, "");
        vm.prank(provider);
        kernel.submit(direct, DELIVERABLE, "");
        vm.expectRevert(IClaimMarket.NotOptimisticJob.selector);
        vm.prank(provider);
        market.list(direct, PRICE);
    }

    function test_list_priceMustBeStrictlyBetweenZeroAndFace() public {
        uint256 jobId = submittedHookedJob(BUDGET);
        uint64 face = uint64(kernel.netPayout(jobId));
        vm.expectRevert(IClaimMarket.BadPrice.selector);
        vm.prank(provider);
        market.list(jobId, 0);
        vm.expectRevert(IClaimMarket.BadPrice.selector);
        vm.prank(provider);
        market.list(jobId, face);
        vm.expectEmit(true, true, false, true);
        emit IClaimMarket.ClaimListed(jobId, provider, face - 1, face);
        vm.prank(provider);
        market.list(jobId, face - 1);
        IClaimMarket.Listing memory l = market.getListing(jobId);
        assertEq(l.faceValue, face);
        assertEq(uint8(l.status), uint8(IClaimMarket.Status.Listed));
    }

    function test_list_oneActiveListingPerJob() public {
        uint256 jobId = _listed();
        vm.expectRevert(IClaimMarket.ListingActive.selector);
        vm.prank(provider);
        market.list(jobId, PRICE - 1);
        vm.prank(provider);
        market.cancel(jobId);
        vm.prank(provider);
        market.list(jobId, PRICE - 1);
        assertEq(market.getListing(jobId).price, PRICE - 1);
    }

    function test_list_blockedWhileDisputed() public {
        uint256 jobId = submittedHookedJob(BUDGET);
        vm.prank(client);
        keeper.dispute(jobId, bytes32(0));
        vm.expectRevert(IClaimMarket.Disputed.selector);
        vm.prank(provider);
        market.list(jobId, PRICE);
    }

    function test_buy_paysSellerDirectlyAndCrystallises() public {
        uint256 jobId = _listed();
        uint256 sellerBefore = usdc.balanceOf(provider);
        uint256 buyerBefore = usdc.balanceOf(buyer);
        vm.expectEmit(true, true, true, true);
        emit IClaimMarket.ClaimBought(jobId, buyer, provider, PRICE);
        vm.prank(buyer);
        market.buy(jobId);
        assertEq(usdc.balanceOf(provider), sellerBefore + PRICE, "the agent has its money now");
        assertEq(usdc.balanceOf(buyer), buyerBefore - PRICE);
        assertEq(market.payeeOf(jobId), buyer);
        vm.expectRevert(IClaimMarket.NotListed.selector);
        vm.prank(provider);
        market.cancel(jobId);
        vm.expectRevert(IClaimMarket.NotListed.selector);
        vm.prank(stranger);
        market.buy(jobId);
    }

    function test_buy_buyerCannotBeSellerOrClient() public {
        uint256 jobId = _listed();
        vm.expectRevert(IClaimMarket.BuyerIsSeller.selector);
        vm.prank(provider);
        market.buy(jobId);
        vm.expectRevert(IClaimMarket.BuyerIsClient.selector);
        vm.prank(client);
        market.buy(jobId);
    }

    function test_buy_blockedWhileDisputed() public {
        uint256 jobId = _listed();
        vm.prank(client);
        keeper.dispute(jobId, bytes32(0));
        vm.expectRevert(IClaimMarket.Disputed.selector);
        vm.prank(buyer);
        market.buy(jobId);
    }

    function test_cancel_onlySellerOnlyListed() public {
        uint256 jobId = _listed();
        vm.expectRevert(IClaimMarket.OnlySeller.selector);
        vm.prank(stranger);
        market.cancel(jobId);
        vm.prank(provider);
        market.cancel(jobId);
        assertEq(market.payeeOf(jobId), provider);
        vm.expectRevert(IClaimMarket.NotListed.selector);
        vm.prank(provider);
        market.cancel(jobId);
    }

    function test_settlement_soldClaimPaysTheBuyer() public {
        uint256 jobId = _sold();
        pastWindow(jobId);
        vm.prank(cranker);
        keeper.finalize(jobId, "");
        assertEq(kernel.withdrawable(buyer), netOf(BUDGET), "face value to the buyer");
        assertEq(kernel.withdrawable(provider), 0);
        assertEq(record(jobId).payee, buyer);
        assertSolvent();
    }

    function test_settlement_unsoldClaimPaysTheProvider() public {
        uint256 jobId = _listed();
        pastWindow(jobId);
        keeper.finalize(jobId, "");
        assertEq(kernel.withdrawable(provider), netOf(BUDGET));
        assertEq(kernel.withdrawable(buyer), 0);
    }

    function test_settlement_cancelledClaimPaysTheProvider() public {
        uint256 jobId = _listed();
        vm.prank(provider);
        market.cancel(jobId);
        pastWindow(jobId);
        keeper.finalize(jobId, "");
        assertEq(kernel.withdrawable(provider), netOf(BUDGET));
    }

    function test_reputation_staysWithTheProviderWhenTheClaimIsSold() public {
        uint256 jobId = _sold();
        pastWindow(jobId);
        keeper.finalize(jobId, "");
        assertEq(reputation.feedbackCount(AGENT_ID), 1);
        MockReputationRegistry.Feedback memory f = reputation.feedbackAt(AGENT_ID, 0);
        assertEq(f.value, 1);
        assertEq(f.tag2, "completed");
        assertEq(hook.agentOf(jobId), AGENT_ID, "credited to the agent that did the work");
        assertEq(identity.ownerOf(AGENT_ID), provider);
        assertTrue(record(jobId).payee == buyer && identity.ownerOf(AGENT_ID) != buyer, "money moved, credit did not");
    }

    function test_disputeRisk_buyerLosesPrincipalWhenTheClientWins() public {
        uint256 jobId = _sold();
        vm.prank(client);
        keeper.dispute(jobId, bytes32(0));
        vote(arb1, jobId, IArbitration.Outcome.Reject, 0);
        vote(arb2, jobId, IArbitration.Outcome.Reject, 0);
        assertEq(uint8(status(jobId)), uint8(ISquareJob.JobStatus.Rejected));
        assertEq(kernel.withdrawable(client), BUDGET);
        assertEq(kernel.withdrawable(buyer), 0, "the buyer paid the seller and gets nothing back");
        assertEq(usdc.balanceOf(provider), PRICE, "the seller keeps the price");
    }

    function test_disputeRisk_buyerCollectsWhenTheProviderWins() public {
        uint256 jobId = _sold();
        vm.prank(client);
        keeper.dispute(jobId, bytes32(0));
        uint64 bond = arbitration.disputeOf(jobId).bond;
        vote(arb1, jobId, IArbitration.Outcome.Complete, FULL_BPS);
        vote(arb2, jobId, IArbitration.Outcome.Complete, FULL_BPS);
        vm.prank(cranker);
        keeper.finalizeDecided(jobId, "");
        assertEq(kernel.withdrawable(buyer), netOf(BUDGET));
        assertEq(arbitration.withdrawable(buyer), bond, "the bond follows the party that carried the risk");
    }

    function test_expiryAfterSale_refundsTheClientNotTheBuyer() public {
        uint256 jobId = _sold();
        vm.warp(expiry());
        kernel.claimRefund(jobId);
        assertEq(kernel.withdrawable(client), BUDGET);
        assertEq(kernel.withdrawable(buyer), 0, "claimRefund is not hookable, so nothing routes to the buyer");
    }
}
