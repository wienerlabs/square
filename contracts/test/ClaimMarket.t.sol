// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {BaseTest} from "./Base.t.sol";
import {BuyerTree} from "./BuyerLists.sol";
import {IPolicyRegistry} from "../src/interfaces/IPolicyRegistry.sol";
import {ISquareJob} from "../src/interfaces/ISquareJob.sol";
import {IClaimMarket} from "../src/interfaces/IClaimMarket.sol";
import {IArbitration} from "../src/interfaces/IArbitration.sol";
import {MockReputationRegistry} from "./mocks/MockRegistries.sol";
import {ClaimMarket} from "../src/ClaimMarket.sol";
import {MaliciousHook} from "./mocks/MaliciousHook.sol";
import {SquareHook} from "../src/SquareHook.sol";

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
        buyAs(buyer, jobId, PRICE);
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
        buyAs(buyer, jobId, PRICE);
        assertEq(usdc.balanceOf(provider), sellerBefore + PRICE, "the agent has its money now");
        assertEq(usdc.balanceOf(buyer), buyerBefore - PRICE);
        assertEq(market.payeeOf(jobId), buyer);
        vm.expectRevert(IClaimMarket.NotListed.selector);
        vm.prank(provider);
        market.cancel(jobId);
        vm.expectRevert(IClaimMarket.NotListed.selector);
        vm.prank(stranger);
        market.buy(jobId, PRICE, bytes32(0), new bytes32[](0));
    }

    function test_buy_buyerCannotBeSellerOrClient() public {
        uint256 jobId = _listed();
        vm.expectRevert(IClaimMarket.BuyerIsSeller.selector);
        vm.prank(provider);
        market.buy(jobId, PRICE, bytes32(0), new bytes32[](0));
        vm.expectRevert(IClaimMarket.BuyerIsClient.selector);
        vm.prank(client);
        market.buy(jobId, PRICE, bytes32(0), new bytes32[](0));
    }

    function test_buy_blockedWhileDisputed() public {
        uint256 jobId = _listed();
        vm.prank(client);
        keeper.dispute(jobId, bytes32(0));
        vm.expectRevert(IClaimMarket.Disputed.selector);
        buyAs(buyer, jobId, PRICE);
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

    function test_expiryAfterSale_refundIsClosedAndTheBuyerIsStillPaid() public {
        uint256 jobId = _sold();
        vm.warp(expiry());
        vm.expectRevert(ISquareJob.SettledByEvaluator.selector);
        kernel.claimRefund(jobId);
        vm.prank(buyer);
        keeper.finalize(jobId, "");
        assertEq(kernel.withdrawable(buyer), netOf(BUDGET), "the buyer cranks it and is paid");
        assertEq(kernel.withdrawable(client), 0);
    }

    function test_list_revertsWhenTheHookDoesNotRouteThePayout() public {
        uint256 jobId = submittedJob(BUDGET, address(0));
        assertFalse(record(jobId).hookResolvesPayout);
        vm.expectRevert(IClaimMarket.PayoutNotRouted.selector);
        vm.prank(provider);
        market.list(jobId, PRICE);
        vm.expectRevert(IClaimMarket.NotListed.selector);
        buyAs(buyer, jobId, PRICE);
    }

    function test_list_revertsWhenTheResolverReadsAnotherMarket() public {
        ClaimMarket other = new ClaimMarket(address(kernel), address(keeper), address(registry));
        SquareHook foreign = new SquareHook(
            address(kernel),
            address(other),
            address(identity),
            address(reputation),
            address(validation),
            owner,
            address(keeper),
            MIN_REPUTATION_BUDGET
        );
        vm.prank(owner);
        kernel.setHookWhitelist(address(foreign), true);
        uint256 jobId = submittedJob(BUDGET, address(foreign));
        assertTrue(record(jobId).hookResolvesPayout);
        vm.expectRevert(IClaimMarket.PayoutNotRouted.selector);
        vm.prank(provider);
        market.list(jobId, PRICE);
        vm.prank(provider);
        other.list(jobId, PRICE);
        assertEq(uint8(other.getListing(jobId).status), uint8(IClaimMarket.Status.Listed));
    }

    function test_regression_aSaleWithoutARouterCanNoLongerPayTheSellerTwice() public {
        uint256 jobId = submittedJob(BUDGET, address(0));
        uint256 buyerBefore = usdc.balanceOf(buyer);
        vm.expectRevert(IClaimMarket.PayoutNotRouted.selector);
        vm.prank(provider);
        market.list(jobId, PRICE);
        pastWindow(jobId);
        keeper.finalize(jobId, "");
        assertEq(kernel.withdrawable(provider), netOf(BUDGET), "the provider is paid exactly once");
        assertEq(usdc.balanceOf(buyer), buyerBefore, "nobody could buy a claim the kernel would not honour");
        assertEq(usdc.balanceOf(provider), 0);
    }

    function test_buy_bindsTheBuyerToTheListedPrice() public {
        uint256 jobId = _listed();
        uint64 raised = uint64(984 * USDC);
        vm.prank(provider);
        market.cancel(jobId);
        vm.prank(provider);
        market.list(jobId, raised);
        uint256 buyerBefore = usdc.balanceOf(buyer);
        vm.expectRevert(abi.encodeWithSelector(IClaimMarket.PriceMismatch.selector, PRICE, raised));
        buyAs(buyer, jobId, PRICE);
        assertEq(usdc.balanceOf(buyer), buyerBefore, "the buyer paid nothing at a price they did not agree to");
        buyAs(buyer, jobId, raised);
        assertEq(usdc.balanceOf(buyer), buyerBefore - raised);
        assertEq(market.payeeOf(jobId), buyer);
    }

    function test_liveJob_capsTheGasOfTheRoutingProbe() public {
        MaliciousHook rogue = new MaliciousHook(address(kernel));
        vm.prank(owner);
        kernel.setHookWhitelist(address(rogue), true);
        uint256 jobId = submittedJob(BUDGET, address(rogue));
        rogue.setMode(MaliciousHook.Mode.Loop);
        uint256 gasBefore = gasleft();
        vm.expectRevert(IClaimMarket.PayoutNotRouted.selector);
        vm.prank(provider);
        market.list{gas: 3_000_000}(jobId, PRICE);
        assertLt(gasBefore - gasleft(), 400_000, "a looping probe is cut off at the cap instead of eating the call");
    }

    // ----------------------------------------------------- who may buy (#30)

    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(market), type(uint256).max);
    }

    /// A buyer off the client's list is refused, and pays nothing for trying.
    function test_eligibility_aBuyerOffTheListCannotBuy() public {
        uint256 jobId = _listed();
        _fund(stranger, PRICE);
        vm.expectRevert(IClaimMarket.BuyerNotEligible.selector);
        vm.prank(stranger);
        market.buy(jobId, PRICE, bytes32(vm.randomUint()), new bytes32[](0));
        assertEq(usdc.balanceOf(stranger), PRICE, "nothing was taken");
        assertEq(market.payeeOf(jobId), provider, "the claim still pays the provider");
        assertEq(uint8(market.getListing(jobId).status), uint8(IClaimMarket.Status.Listed), "and is still for sale");
    }

    /// A buyer's salt and path are public the moment its transaction is
    /// broadcast. They prove nothing for anyone else, because the leaf is
    /// rebuilt from `msg.sender`.
    function test_eligibility_aCopiedPathProvesNothingForTheCopier() public {
        uint256 jobId = _listed();
        _fund(stranger, PRICE);
        (bytes32 salt, bytes32[] memory path) = eligibility(client, buyer);
        vm.expectRevert(IClaimMarket.BuyerNotEligible.selector);
        vm.prank(stranger);
        market.buy(jobId, PRICE, salt, path);

        vm.prank(buyer);
        market.buy(jobId, PRICE, salt, path);
        assertEq(market.payeeOf(jobId), buyer, "the same path works for the address it was issued to");
    }

    /// The salt is part of the leaf: the right path under the wrong salt fails.
    function test_eligibility_theSaltIsPartOfTheLeaf() public {
        uint256 jobId = _listed();
        (bytes32 salt, bytes32[] memory path) = eligibility(client, buyer);
        vm.expectRevert(IClaimMarket.BuyerNotEligible.selector);
        vm.prank(buyer);
        market.buy(jobId, PRICE, bytes32(uint256(salt) ^ 1), path);
    }

    /// A cleared list approves nobody, including a buyer approved a moment ago.
    function test_eligibility_aClearedListApprovesNobody() public {
        uint256 jobId = _listed();
        (bytes32 salt, bytes32[] memory path) = eligibility(client, buyer);
        vm.prank(client);
        registry.setBuyerRoot(bytes32(0));
        vm.expectRevert(IClaimMarket.BuyerNotEligible.selector);
        vm.prank(buyer);
        market.buy(jobId, PRICE, salt, path);
        assertEq(market.payeeOf(jobId), provider);
    }

    /// Eligibility is judged against the poster of the job being bought. A
    /// poster who never wrote a list approves nobody; a place on one poster's
    /// list is no answer for another's.
    function test_eligibility_theListIsThePostersOwn() public {
        address poster = makeAddr("poster");
        usdc.mint(poster, BUDGET);
        vm.prank(poster);
        usdc.approve(address(kernel), BUDGET);
        vm.prank(poster);
        uint256 jobId = kernel.createJob(provider, address(keeper), expiry(), "spec:0xabc", address(hook));
        vm.prank(provider);
        kernel.setBudget(jobId, BUDGET, "");
        vm.prank(poster);
        kernel.fund(jobId, BUDGET, "");
        vm.prank(provider);
        kernel.submit(jobId, DELIVERABLE, abi.encode(AGENT_ID, REQUEST_HASH));
        vm.prank(provider);
        market.list(jobId, PRICE);
        _fund(buyerB, PRICE);

        assertEq(registry.buyerRootOf(poster), bytes32(0));
        (bytes32 salt, bytes32[] memory path) = eligibility(client, buyerB);
        vm.expectRevert(IClaimMarket.BuyerNotEligible.selector);
        vm.prank(buyerB);
        market.buy(jobId, PRICE, salt, path);

        // A list of one: the leaf is its own root and the path is empty.
        address[] memory approved = new address[](1);
        approved[0] = buyerB;
        approveBuyers(registry, poster, approved);

        (salt, path) = eligibility(client, buyer);
        vm.expectRevert(IClaimMarket.BuyerNotEligible.selector);
        vm.prank(buyer);
        market.buy(jobId, PRICE, salt, path);

        buyFrom(market, poster, buyerB, jobId, PRICE);
        assertEq(market.payeeOf(jobId), buyerB);
    }

    /// What reaches the chain when a poster publishes a list: one root, in one
    /// slot, and an event carrying the poster and that root. Not the addresses,
    /// not how many there are, not who stands behind them.
    function test_privacy_publishingAListWritesTheRootAndNothingElse() public {
        address[] memory approved = new address[](3);
        approved[0] = buyer;
        approved[1] = buyerB;
        approved[2] = buyerC;
        vm.record();
        vm.recordLogs();
        bytes32 root = approveBuyers(registry, client, approved);
        (, bytes32[] memory writes) = vm.accesses(address(registry));
        assertEq(writes.length, 1, "one slot written");
        assertEq(vm.load(address(registry), writes[0]), root, "and it holds the root");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "one event");
        assertEq(logs[0].topics.length, 3);
        assertEq(logs[0].topics[0], IPolicyRegistry.BuyerRootCommitted.selector);
        assertEq(logs[0].topics[1], bytes32(uint256(uint160(client))));
        assertEq(logs[0].topics[2], root);
        assertEq(logs[0].data.length, 0, "and nothing beside them");
    }

    /// What reaches the chain when a buyer buys: its own salt and a path of
    /// hashes. The path does hold the other members' leaves, salted, so an
    /// observer who suspects an address is on the list has nothing to test the
    /// suspicion against. The first two assertions are the control: the
    /// members really are in the path, recognisable only with their salts.
    function test_privacy_aPurchaseRevealsNoOtherMember() public view {
        (, bytes32[] memory path) = eligibility(client, buyer);
        assertEq(path.length, 2, "a sibling, then the unpaired node");
        assertEq(path[0], BuyerTree.leaf(buyerB, saltOf[client][buyerB]));
        assertEq(path[1], BuyerTree.leaf(buyerC, saltOf[client][buyerC]));
        address[2] memory others = [buyerB, buyerC];
        for (uint256 o = 0; o < others.length; o++) {
            for (uint256 i = 0; i < path.length; i++) {
                assertNotEq(path[i], BuyerTree.leaf(others[o], bytes32(0)), "an unsalted guess matches nothing");
                assertNotEq(path[i], keccak256(abi.encode(others[o])), "nor does the address hashed");
                assertNotEq(path[i], bytes32(uint256(uint160(others[o]))), "nor the address itself");
            }
        }
    }
}
