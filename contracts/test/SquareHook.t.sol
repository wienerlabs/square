// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {ISquareJob} from "../src/interfaces/ISquareJob.sol";
import {IACPHook} from "../src/interfaces/IACPHook.sol";
import {IPayoutResolver} from "../src/interfaces/IPayoutResolver.sol";
import {SquareHook} from "../src/SquareHook.sol";
import {MockComplianceModule} from "./mocks/MockComplianceModule.sol";
import {MockReputationRegistry} from "./mocks/MockRegistries.sol";
import {IClaimMarket} from "../src/interfaces/IClaimMarket.sol";
import {KernelBatcher} from "./mocks/KernelBatcher.sol";

contract SquareHookTest is BaseTest {
    uint256 internal constant BUDGET = 1_000 * USDC;

    function test_supportsBothInterfaces() public view {
        assertTrue(hook.supportsInterface(type(IACPHook).interfaceId));
        assertTrue(hook.supportsInterface(type(IPayoutResolver).interfaceId));
    }

    function test_onlyTheKernelMayCallTheCallbacks() public {
        vm.expectRevert(SquareHook.OnlyKernel.selector);
        vm.prank(stranger);
        hook.beforeAction(1, ISquareJob.submit.selector, "");
        vm.expectRevert(SquareHook.OnlyKernel.selector);
        vm.prank(stranger);
        hook.afterAction(1, ISquareJob.complete.selector, "");
    }

    function test_submit_bindsAnAgentTheProviderOwns() public {
        uint256 jobId = fundedJob(BUDGET, address(hook));
        vm.expectEmit(true, true, false, true);
        emit SquareHook.AgentBound(jobId, AGENT_ID, REQUEST_HASH);
        vm.prank(provider);
        kernel.submit(jobId, DELIVERABLE, abi.encode(AGENT_ID, REQUEST_HASH));
        assertEq(hook.agentOf(jobId), AGENT_ID);
        assertEq(hook.validationOf(jobId), REQUEST_HASH);
    }

    function test_submit_refusesSomeoneElsesAgent() public {
        identity.setAgent(7, stranger, stranger);
        uint256 jobId = fundedJob(BUDGET, address(hook));
        vm.expectRevert(abi.encodeWithSelector(SquareHook.AgentNotOwnedByProvider.selector, 7, provider));
        vm.prank(provider);
        kernel.submit(jobId, DELIVERABLE, abi.encode(uint256(7), bytes32(0)));
    }

    function test_submit_acceptsAgentWalletOwnership() public {
        identity.setAgent(8, stranger, provider);
        uint256 jobId = fundedJob(BUDGET, address(hook));
        vm.prank(provider);
        kernel.submit(jobId, DELIVERABLE, abi.encode(uint256(8), bytes32(0)));
        assertEq(hook.agentOf(jobId), 8);
    }

    function test_submit_registryWithoutWalletsFallsBackToOwner() public {
        identity.setWalletsSupported(false);
        identity.setAgent(9, stranger, provider);
        uint256 jobId = fundedJob(BUDGET, address(hook));
        vm.expectRevert(abi.encodeWithSelector(SquareHook.AgentNotOwnedByProvider.selector, 9, provider));
        vm.prank(provider);
        kernel.submit(jobId, DELIVERABLE, abi.encode(uint256(9), bytes32(0)));
    }

    function test_submit_withoutOptParamsBindsNothing() public {
        uint256 jobId = fundedJob(BUDGET, address(hook));
        vm.prank(provider);
        kernel.submit(jobId, DELIVERABLE, "");
        vm.expectRevert(SquareHook.NoAgentBound.selector);
        hook.agentOf(jobId);
        (bool bound, uint256 agentId) = hook.boundAgentOf(jobId);
        assertFalse(bound);
        assertEq(agentId, 0);
        pastWindow(jobId);
        keeper.finalize(jobId, "");
        assertEq(reputation.feedbackCount(AGENT_ID), 0, "no agent, no feedback");
    }

    /// Agent id 0 is a real agent: on Arc's registry it is the first
    /// registration. Before square#300 the hook stored the id itself and read
    /// 0 as "no agent bound", so a job bound to agent 0 was bound by
    /// beforeAction, skipped by _writeReputation and refused by recordExpiry.
    function test_submit_bindsAgentZeroLikeAnyOther() public {
        identity.setAgent(0, provider, provider);
        uint256 jobId = fundedJob(BUDGET, address(hook));
        vm.expectEmit(true, true, false, true);
        emit SquareHook.AgentBound(jobId, 0, bytes32(0));
        vm.prank(provider);
        kernel.submit(jobId, DELIVERABLE, abi.encode(uint256(0), bytes32(0)));
        assertEq(hook.agentOf(jobId), 0);
        (bool bound, uint256 agentId) = hook.boundAgentOf(jobId);
        assertTrue(bound);
        assertEq(agentId, 0);

        pastWindow(jobId);
        vm.expectEmit(true, true, false, true);
        emit SquareHook.ReputationRecorded(jobId, 0, 1, 1);
        keeper.finalize(jobId, "");
        assertEq(reputation.feedbackCount(0), 1, "agent 0 earns its feedback");
        assertTrue(hook.recorded(jobId));
    }

    function test_recordExpiry_acceptsAJobBoundToAgentZero() public {
        identity.setAgent(0, provider, provider);
        uint256 jobId = _hookedJobWithoutAHorizon(abi.encode(uint256(0), bytes32(0)));
        vm.warp(expiry());
        kernel.claimRefund(jobId);
        vm.prank(stranger);
        hook.recordExpiry(jobId);
        MockReputationRegistry.Feedback memory f = reputation.feedbackAt(0, 0);
        assertEq(f.value, 0);
        assertEq(f.tag2, "expired");
    }

    function test_complete_writesPositiveFeedbackWithTheReasonAsHash() public {
        uint256 jobId = submittedHookedJob(BUDGET);
        pastWindow(jobId);
        bytes32 reason = keeper.finalizeReason(jobId, DELIVERABLE);
        vm.expectEmit(true, true, false, true);
        emit SquareHook.ReputationRecorded(jobId, AGENT_ID, 1, 1);
        keeper.finalize(jobId, "");
        MockReputationRegistry.Feedback memory f = reputation.feedbackAt(AGENT_ID, 0);
        assertEq(f.client, address(hook));
        assertEq(f.value, 1);
        assertEq(f.valueDecimals, 0);
        assertEq(f.tag1, "square");
        assertEq(f.tag2, "completed");
        assertEq(f.feedbackHash, reason);
        assertTrue(hook.recorded(jobId));
    }

    function test_complete_withoutModuleWritesNoValidation() public {
        uint256 jobId = submittedHookedJob(BUDGET);
        pastWindow(jobId);
        vm.expectEmit(true, true, false, true);
        emit SquareHook.ComplianceChecked(jobId, provider, netOf(BUDGET), false);
        keeper.finalize(jobId, "");
        (address responder,,) = validation.responses(REQUEST_HASH);
        assertEq(responder, address(0), "nothing was verified, nothing is claimed");
    }

    function test_complete_aStrangerCannotZeroThePayoutWithFabricatedBytes() public {
        vm.prank(owner);
        hook.setComplianceModule(address(compliance));
        compliance.setExpectedProof(keccak256(hex"deadbeef"));
        uint256 jobId = submittedHookedJob(BUDGET);
        vm.prank(client);
        kernel.setComplianceProof(jobId, hex"deadbeef");
        pastWindow(jobId);

        vm.prank(stranger);
        keeper.finalize(jobId, hex"c0ffee");

        assertEq(kernel.withdrawable(provider), netOf(BUDGET), "the crank's bytes decided nothing");
        assertEq(kernel.withdrawable(client), 0, "and the client was handed nothing back");
        assertEq(compliance.lastCheck().proof, hex"deadbeef");
    }

    function test_complete_anEmptyProofFromACrankDoesNotPunishTheProvider() public {
        vm.prank(owner);
        hook.setComplianceModule(address(compliance));
        compliance.setExpectedProof(keccak256(hex"deadbeef"));
        uint256 jobId = submittedHookedJob(BUDGET);
        vm.prank(client);
        kernel.setComplianceProof(jobId, hex"deadbeef");
        pastWindow(jobId);

        vm.prank(stranger);
        keeper.finalize(jobId, "");

        assertEq(kernel.withdrawable(provider), netOf(BUDGET), "an empty crank is not a refusal");
    }

    function test_complete_aSoldClaimIsProtectedTheSameWay() public {
        vm.prank(owner);
        hook.setComplianceModule(address(compliance));
        compliance.setExpectedProof(keccak256(hex"deadbeef"));
        uint256 jobId = submittedHookedJob(BUDGET);
        vm.prank(provider);
        market.list(jobId, uint64(900 * USDC));
        vm.prank(buyer);
        market.buy(jobId, uint64(900 * USDC));
        vm.prank(client);
        kernel.setComplianceProof(jobId, hex"deadbeef");
        pastWindow(jobId);

        vm.prank(stranger);
        keeper.finalize(jobId, hex"c0ffee");

        assertEq(kernel.withdrawable(buyer), netOf(BUDGET), "the buyer keeps the receivable it paid for");
        assertEq(kernel.withdrawable(client), 0);
    }

    function test_setComplianceProof_belongsToTheClientAndToALiveJob() public {
        uint256 jobId = submittedHookedJob(BUDGET);

        vm.expectRevert(ISquareJob.Unauthorized.selector);
        vm.prank(stranger);
        kernel.setComplianceProof(jobId, hex"deadbeef");
        vm.expectRevert(ISquareJob.Unauthorized.selector);
        vm.prank(provider);
        kernel.setComplianceProof(jobId, hex"deadbeef");

        vm.prank(client);
        kernel.setComplianceProof(jobId, hex"deadbeef");
        assertEq(kernel.complianceProofOf(jobId), hex"deadbeef");

        vm.prank(client);
        kernel.setComplianceProof(jobId, hex"feed");
        assertEq(kernel.complianceProofOf(jobId), hex"feed", "the client may replace its own proof");

        bytes memory tooLong = new bytes(kernel.MAX_COMPLIANCE_PROOF() + 1);
        vm.expectRevert(
            abi.encodeWithSelector(ISquareJob.ComplianceProofTooLarge.selector, kernel.MAX_COMPLIANCE_PROOF())
        );
        vm.prank(client);
        kernel.setComplianceProof(jobId, tooLong);

        pastWindow(jobId);
        vm.prank(cranker);
        keeper.finalize(jobId, "");
        vm.expectRevert(ISquareJob.WrongStatus.selector);
        vm.prank(client);
        kernel.setComplianceProof(jobId, hex"deadbeef");
    }

    function test_complete_withModuleBindsPayeeAmountTokenClientAndProof() public {
        vm.prank(owner);
        hook.setComplianceModule(address(compliance));
        uint256 jobId = submittedHookedJob(BUDGET);
        vm.prank(provider);
        market.list(jobId, uint64(900 * USDC));
        vm.prank(buyer);
        market.buy(jobId, uint64(900 * USDC));
        pastWindow(jobId);

        bytes memory proof = hex"deadbeef";
        vm.prank(client);
        kernel.setComplianceProof(jobId, proof);
        vm.expectEmit(true, true, false, true);
        emit SquareHook.ComplianceChecked(jobId, buyer, netOf(BUDGET), true);
        vm.expectEmit(true, true, false, true);
        emit SquareHook.ValidationRecorded(jobId, REQUEST_HASH, 100);
        vm.prank(stranger);
        keeper.finalize(jobId, hex"c0ffee");

        MockComplianceModule.Check memory c = compliance.lastCheck();
        assertEq(c.jobId, jobId);
        assertEq(c.payee, buyer, "bound to the address that is actually paid");
        assertEq(c.amount, netOf(BUDGET));
        assertEq(c.token, address(usdc));
        assertEq(c.client, client);
        assertEq(c.proof, proof, "the module reads the job's proof, not the crank's bytes");
        (address validator,, uint8 response,, string memory tag,) =
            validation.getValidationStatus(REQUEST_HASH);
        assertEq(validator, address(hook));
        assertEq(response, 100);
        assertEq(tag, "square.compliance");
    }

    /// A refused check settles the job and pays the provider nothing.
    ///
    /// Both halves matter and they came from different issues. #100 established
    /// that the job must still settle: a module that vetoes by reverting left
    /// the escrow with no exit once #90 closed the refund, so the kernel stopped
    /// letting a hook veto. #27 then had to make the refusal mean something, and
    /// the only channel the kernel honours is the split — so the whole net goes
    /// back to the client and the provider is not paid.
    ///
    /// Before #27 this asserted `withdrawable(provider) == netOf(BUDGET)`: the
    /// module's verdict was advisory and money moved regardless.
    function test_complete_moduleRejectionSettlesTheJobAndPaysTheProviderNothing() public {
        vm.prank(owner);
        hook.setComplianceModule(address(compliance));
        compliance.setRejectAll(true);
        uint256 jobId = submittedHookedJob(BUDGET);
        pastWindow(jobId);
        vm.expectEmit(true, false, false, true);
        emit SquareHook.ComplianceCheckFailed(
            jobId,
            abi.encodeWithSelector(
                MockComplianceModule.ReleaseNotCompliant.selector, jobId, provider, netOf(BUDGET)
            )
        );
        vm.expectEmit(true, true, false, true);
        emit SquareHook.ComplianceChecked(jobId, provider, netOf(BUDGET), false);
        keeper.finalize(jobId, "");
        assertEq(
            uint8(status(jobId)),
            uint8(ISquareJob.JobStatus.Completed),
            "a rejected check is a signal, not a lock"
        );
        assertEq(kernel.withdrawable(provider), 0, "a refused release pays the provider nothing");
        assertEq(kernel.withdrawable(client), netOf(BUDGET), "and returns the whole net to the client");
        (address responder, uint8 response,) = validation.responses(REQUEST_HASH);
        assertEq(responder, address(hook));
        assertEq(response, 0, "the failed check is on the record");
    }

    function test_complete_splitAmountIsTheProviderShare() public {
        vm.prank(owner);
        hook.setComplianceModule(address(compliance));
        uint256 jobId = submittedHookedJob(BUDGET);
        vm.prank(address(keeper));
        kernel.complete(jobId, bytes32(0), abi.encode(uint16(2_500), bytes("")));
        assertEq(compliance.lastCheck().amount, (netOf(BUDGET) * 2_500) / FULL_BPS);
        assertEq(kernel.withdrawable(provider), (netOf(BUDGET) * 2_500) / FULL_BPS);
    }

    function test_complete_registryFailureDoesNotBlockSettlement() public {
        reputation.setShouldRevert(true);
        validation.setShouldRevert(true);
        vm.prank(owner);
        hook.setComplianceModule(address(compliance));
        uint256 jobId = submittedHookedJob(BUDGET);
        pastWindow(jobId);
        vm.expectEmit(true, true, false, false);
        emit SquareHook.ReputationWriteFailed(jobId, AGENT_ID, "");
        vm.expectEmit(true, true, false, false);
        emit SquareHook.ValidationWriteFailed(jobId, REQUEST_HASH, "");
        keeper.finalize(jobId, "");
        assertEq(uint8(status(jobId)), uint8(ISquareJob.JobStatus.Completed), "money is settled regardless");
        assertEq(kernel.withdrawable(provider), netOf(BUDGET));
        assertTrue(hook.recorded(jobId), "one attempt per job, even a failed one");
    }

    function test_reject_afterSubmissionWritesNegativeFeedbackAndFailedValidation() public {
        uint256 jobId = submittedHookedJob(BUDGET);
        vm.prank(address(keeper));
        kernel.reject(jobId, keccak256("bad work"), "");
        MockReputationRegistry.Feedback memory f = reputation.feedbackAt(AGENT_ID, 0);
        assertEq(f.value, -1);
        assertEq(f.tag2, "rejected");
        assertEq(f.feedbackHash, keccak256("bad work"));
        (,, uint8 response,,,) = validation.getValidationStatus(REQUEST_HASH);
        assertEq(response, 0);
    }

    function test_reject_beforeSubmissionWritesNothing() public {
        uint256 jobId = fundedJob(BUDGET, address(hook));
        vm.prank(address(keeper));
        kernel.reject(jobId, bytes32(0), "");
        assertEq(reputation.feedbackCount(AGENT_ID), 0);
        uint256 open = createJob(BUDGET, address(hook));
        vm.prank(client);
        kernel.reject(open, bytes32(0), "");
        assertEq(reputation.feedbackCount(AGENT_ID), 0);
    }

    function _hookedJobWithoutAHorizon(bytes memory optParams) internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = kernel.createJob(provider, client, expiry(), "spec:0xabc", address(hook));
        vm.prank(provider);
        kernel.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        kernel.fund(jobId, BUDGET, "");
        vm.prank(provider);
        kernel.submit(jobId, DELIVERABLE, optParams);
    }

    function test_recordExpiry_neutralOnceAndOnlyWhenExpired() public {
        uint256 jobId = _hookedJobWithoutAHorizon(abi.encode(AGENT_ID, REQUEST_HASH));
        vm.expectRevert(SquareHook.NotExpired.selector);
        hook.recordExpiry(jobId);
        vm.warp(expiry());
        kernel.claimRefund(jobId);
        vm.prank(stranger);
        hook.recordExpiry(jobId);
        MockReputationRegistry.Feedback memory f = reputation.feedbackAt(AGENT_ID, 0);
        assertEq(f.value, 0);
        assertEq(f.tag2, "expired");
        vm.expectRevert(SquareHook.AlreadyRecorded.selector);
        hook.recordExpiry(jobId);

        uint256 unbound = _hookedJobWithoutAHorizon("");
        vm.warp(expiry());
        kernel.claimRefund(unbound);
        vm.expectRevert(SquareHook.NoAgentBound.selector);
        hook.recordExpiry(unbound);
    }

    function test_recordExpiry_isUnreachableForAnOptimisticJobOnceSubmitted() public {
        uint256 jobId = submittedHookedJob(BUDGET);
        vm.warp(expiry());
        vm.expectRevert(ISquareJob.SettledByEvaluator.selector);
        kernel.claimRefund(jobId);
        vm.expectRevert(SquareHook.NotExpired.selector);
        hook.recordExpiry(jobId);
    }

    function test_gasLimit_fitsACompliancCheckOfTheExpectedCost() public {
        vm.prank(owner);
        hook.setComplianceModule(address(compliance));
        compliance.setGasToBurn(400_000);
        uint256 jobId = submittedHookedJob(BUDGET);
        pastWindow(jobId);
        keeper.finalize(jobId, "");
        assertEq(uint8(status(jobId)), uint8(ISquareJob.JobStatus.Completed));
    }

    function test_gasLimit_aRunawayComplianceCheckCannotBlockSettlement() public {
        vm.prank(owner);
        hook.setComplianceModule(address(compliance));
        compliance.setGasToBurn(HOOK_GAS_LIMIT + 100_000);
        uint256 jobId = submittedHookedJob(BUDGET);
        pastWindow(jobId);
        uint256 gasBefore = gasleft();
        vm.expectEmit(true, false, false, false);
        emit SquareHook.ComplianceCheckFailed(jobId, "");
        keeper.finalize{gas: 5_000_000}(jobId, "");
        assertLt(gasBefore - gasleft(), 2_500_000, "the runaway check is cut at the cap");
        assertEq(uint8(status(jobId)), uint8(ISquareJob.JobStatus.Completed));
        assertEq(kernel.withdrawable(provider), netOf(BUDGET));
    }

    function test_gas_hookShareOfComplete() public {
        uint256 hooked = submittedHookedJob(BUDGET);
        uint256 bare = submittedJob(BUDGET, address(0));
        pastWindow(hooked);
        vm.prank(cranker);
        uint256 g0 = gasleft();
        keeper.finalize(hooked, "");
        uint256 withHook = g0 - gasleft();
        vm.prank(cranker);
        g0 = gasleft();
        keeper.finalize(bare, "");
        uint256 withoutHook = g0 - gasleft();
        emit log_named_uint("finalize, hooked", withHook);
        emit log_named_uint("finalize, no hook", withoutHook);
        emit log_named_uint("hook share", withHook - withoutHook);
        assertLt(withHook - withoutHook, HOOK_GAS_LIMIT / 2, "hook share must stay under half the limit");
    }

    function test_setComplianceModule_ownerOnly() public {
        vm.expectRevert();
        vm.prank(stranger);
        hook.setComplianceModule(address(compliance));
        vm.prank(owner);
        hook.setComplianceModule(address(compliance));
        assertEq(hook.complianceModule(), address(compliance));
    }

    function test_submit_refusesAValidationRequestOfAnotherAgent() public {
        uint256 otherAgent = AGENT_ID + 1;
        identity.setAgent(otherAgent, provider, provider);
        bytes32 foreignRequest = keccak256("someone else's request");
        vm.prank(stranger);
        validation.validationRequest(address(hook), 4242, "", foreignRequest);
        uint256 jobId = fundedJob(BUDGET, address(hook));
        vm.expectRevert(abi.encodeWithSelector(SquareHook.ValidationRequestMismatch.selector, foreignRequest));
        vm.prank(provider);
        kernel.submit(jobId, DELIVERABLE, abi.encode(otherAgent, foreignRequest));

        bytes32 otherValidator = keccak256("request naming another validator");
        vm.prank(provider);
        validation.validationRequest(stranger, AGENT_ID, "", otherValidator);
        vm.expectRevert(abi.encodeWithSelector(SquareHook.ValidationRequestMismatch.selector, otherValidator));
        vm.prank(provider);
        kernel.submit(jobId, DELIVERABLE, abi.encode(AGENT_ID, otherValidator));

        vm.prank(provider);
        kernel.submit(jobId, DELIVERABLE, abi.encode(AGENT_ID, bytes32(0)));
        assertEq(hook.validationOf(jobId), bytes32(0), "a zero hash still means no validation was requested");
    }

    function test_reputation_positiveFeedbackNeedsTheTrustedEvaluator() public {
        uint256 jobId = _hookedJobWithoutAHorizon(abi.encode(AGENT_ID, REQUEST_HASH));
        vm.expectEmit(true, true, false, true);
        emit SquareHook.ReputationSkipped(jobId, AGENT_ID, "untrusted evaluator");
        vm.prank(client);
        kernel.complete(jobId, bytes32(0), "");
        assertEq(uint8(status(jobId)), uint8(ISquareJob.JobStatus.Completed), "settlement is untouched");
        assertEq(reputation.feedbackCount(AGENT_ID), 0, "a self-picked evaluator earns no reputation");
        assertTrue(hook.recorded(jobId));
    }

    function test_reputation_positiveFeedbackNeedsTheMinimumBudget() public {
        uint256 small = submittedHookedJob(MIN_REPUTATION_BUDGET - 1);
        pastWindow(small);
        vm.expectEmit(true, true, false, true);
        emit SquareHook.ReputationSkipped(small, AGENT_ID, "budget below minimum");
        keeper.finalize(small, "");
        assertEq(reputation.feedbackCount(AGENT_ID), 0);

        uint256 enough = submittedHookedJob(MIN_REPUTATION_BUDGET);
        pastWindow(enough);
        keeper.finalize(enough, "");
        assertEq(reputation.feedbackCount(AGENT_ID), 1, "the threshold is inclusive");
    }

    function test_reputation_negativeFeedbackIsNotGated() public {
        uint256 jobId = _hookedJobWithoutAHorizon(abi.encode(AGENT_ID, REQUEST_HASH));
        vm.prank(client);
        kernel.reject(jobId, bytes32(0), "");
        assertEq(reputation.feedbackCount(AGENT_ID), 1, "a rejection is written whoever evaluated");
        assertEq(reputation.feedbackAt(AGENT_ID, 0).value, -1);
    }

    function test_setReputationPolicy_ownerOnly() public {
        vm.expectRevert();
        vm.prank(stranger);
        hook.setReputationPolicy(stranger, 0);
        vm.prank(owner);
        hook.setReputationPolicy(address(keeper), 5 * uint64(USDC));
        assertEq(hook.trustedEvaluator(), address(keeper));
        assertEq(hook.minReputationBudget(), 5 * uint64(USDC));
    }

    function test_afterAction_writesNoVerdictWhenTheCheckNeverRan() public {
        vm.prank(owner);
        hook.setComplianceModule(address(compliance));
        uint256 jobId = submittedHookedJob(BUDGET);
        pastWindow(jobId);
        vm.mockCallRevert(
            address(kernel), abi.encodeWithSelector(ISquareJob.netPayout.selector, jobId), "read failed"
        );
        vm.expectEmit(true, true, false, false);
        emit ISquareJob.HookFailed(jobId, address(hook), ISquareJob.complete.selector, "");
        keeper.finalize(jobId, "");
        vm.clearMockedCalls();
        assertEq(uint8(status(jobId)), uint8(ISquareJob.JobStatus.Completed), "settlement is untouched");
        (address responder,,) = validation.responses(REQUEST_HASH);
        assertEq(responder, address(0), "a check that never ran writes no verdict, failed or passed");
        assertEq(compliance.checkCount(), 0, "the module was never reached");
        assertTrue(hook.recorded(jobId), "reputation is written as before");
    }

    function test_afterAction_ignoresACheckThatRanForAnotherJob() public {
        vm.prank(owner);
        hook.setComplianceModule(address(compliance));
        uint256 first = submittedHookedJob(BUDGET);
        bytes32 secondRequest = keccak256("second request");
        vm.prank(provider);
        validation.validationRequest(address(hook), AGENT_ID, "", secondRequest);
        uint256 second = _hookedJobWithoutAHorizon(abi.encode(AGENT_ID, secondRequest));
        bytes memory data = abi.encode(bytes32(0), bytes(""));

        address logic = makeAddr("kernel logic");
        vm.etch(logic, address(kernel).code);
        vm.etch(address(kernel), address(new KernelBatcher(logic)).code);
        KernelBatcher batched = KernelBatcher(payable(address(kernel)));

        batched.completeHooksOf(hook, first, second, data);
        (address responder,,) = validation.responses(secondRequest);
        assertEq(responder, address(0), "the first job's outcome does not leak into the second");

        batched.completeHooksOf(hook, first, first, data);
        (address firstResponder, uint8 response,) = validation.responses(REQUEST_HASH);
        assertEq(firstResponder, address(hook));
        assertEq(response, 100, "and the job the check ran for gets its verdict");
    }

    function test_complete_aModuleThatRefusesWithoutRevertingRecordsAFailedValidation() public {
        vm.prank(owner);
        hook.setComplianceModule(address(compliance));
        compliance.setRefuseAll(true);
        uint256 jobId = submittedHookedJob(BUDGET);
        pastWindow(jobId);
        keeper.finalize(jobId, "");
        assertEq(uint8(status(jobId)), uint8(ISquareJob.JobStatus.Completed));
        assertEq(compliance.checkCount(), 1, "the module ran and kept its state");
        (address responder, uint8 response,) = validation.responses(REQUEST_HASH);
        assertEq(responder, address(hook));
        assertEq(response, 0, "refusal by return value is the shape the decision record asks for");
    }

    function test_resolvePayout_answersTheProbeTheKernelSends() public {
        uint256 jobId = submittedHookedJob(BUDGET);
        (address payee, uint16 providerBps) = hook.resolvePayout(jobId, abi.encode(bytes32(0), bytes("")));
        assertEq(payee, provider);
        assertEq(
            providerBps, FULL_BPS, "empty optParams read as the full share, so the probe and the call agree"
        );
        (address listedPayee,) =
            hook.resolvePayout(jobId, abi.encode(bytes32(0), abi.encode(uint16(4_000), bytes(""))));
        assertEq(listedPayee, payee, "the payee never depends on data");
    }
}
