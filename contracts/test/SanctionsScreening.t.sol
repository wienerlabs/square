// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {ISquareJob} from "../src/interfaces/ISquareJob.sol";
import {IScreeningRegistry} from "../src/interfaces/IScreeningRegistry.sol";
import {ScreeningRegistry} from "../src/ScreeningRegistry.sol";
import {SquareHook} from "../src/SquareHook.sol";
import {IValidationRegistry} from "../src/interfaces/IERC8004.sol";

/// Screening on the settlement path, through the real kernel, keeper and hook.
/// square#35; docs/decisions/sanctions-screening.md.
///
/// At `fund` the hook is called strictly, so a party that is not cleared
/// reverts the funding and nothing enters escrow. At release it is called
/// through `resolvePayout`, where #100 allows no revert, so a payee that is not
/// cleared is paid nothing and the net returns to the client.
contract SanctionsScreeningTest is BaseTest {
    uint256 internal constant BUDGET = 1_000 * USDC;
    uint64 internal constant MAX_AGE = 1 hours;
    bytes32 internal constant SOURCE = "trm-sanctions-v1";

    ScreeningRegistry internal screeningRegistry;
    address internal screener;
    uint256 internal screenerKey;

    function setUp() public override {
        super.setUp();
        (screener, screenerKey) = makeAddrAndKey("screener");
        screeningRegistry = new ScreeningRegistry(owner, MAX_AGE);
        vm.startPrank(owner);
        screeningRegistry.setScreener(screener, true);
        hook.setScreening(address(screeningRegistry));
        vm.stopPrank();
    }

    function _screen(address who, bool sanctioned) internal {
        bytes memory body = abi.encodePacked(
            '[{"address":"', vm.toString(who), '","isSanctioned":', sanctioned ? "true" : "false", "}]"
        );
        IScreeningRegistry.Screening memory s =
            IScreeningRegistry.Screening(who, sanctioned, uint64(vm.getBlockTimestamp()), SOURCE, keccak256(body));
        (uint8 v, bytes32 r, bytes32 sig) = vm.sign(screenerKey, screeningRegistry.digestOf(s));
        screeningRegistry.submit(s, abi.encodePacked(r, sig, v));
    }

    function _clear(address who) internal {
        _screen(who, false);
    }

    function _designate(address who) internal {
        _screen(who, true);
    }

    function _fundAs(uint256 jobId) internal {
        vm.prank(client);
        kernel.fund(jobId, BUDGET, "");
    }

    /// A job cleared at funding, submitted, and past its window.
    function _evidence(uint256 jobId, address payee, uint256 amount, bytes32 screening, uint8 screeningOutcome)
        internal
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(jobId, payee, amount, address(usdc), screening, uint8(0), screeningOutcome));
    }

    function _submittedAndDue() internal returns (uint256 jobId) {
        _clear(client);
        _clear(provider);
        jobId = createJob(BUDGET, address(hook));
        _fundAs(jobId);
        vm.prank(provider);
        kernel.submit(jobId, DELIVERABLE, abi.encode(AGENT_ID, REQUEST_HASH));
        pastWindow(jobId);
    }

    // ---------------------------------------------------------------- funding

    /// #35's third criterion: an empty list cannot pass as working. With the
    /// registry installed and nothing screened, nobody is cleared, and funding
    /// stops rather than going through.
    function test_fund_anEmptyRegistryStopsFunding() public {
        uint256 jobId = createJob(BUDGET, address(hook));
        uint256 clientBefore = usdc.balanceOf(client);
        vm.expectRevert(abi.encodeWithSelector(SquareHook.NotCleared.selector, client));
        _fundAs(jobId);
        assertEq(usdc.balanceOf(client), clientBefore, "nothing entered escrow");
        assertEq(uint8(kernel.getJobRecord(jobId).status), uint8(ISquareJob.JobStatus.Open));
    }

    /// #35's first criterion, at the first of the two points: a screened
    /// (designated) address stops settlement before any money moves.
    function test_fund_aDesignatedProviderStopsFunding() public {
        uint256 jobId = createJob(BUDGET, address(hook));
        _clear(client);
        _designate(provider);
        uint256 clientBefore = usdc.balanceOf(client);
        vm.expectRevert(abi.encodeWithSelector(SquareHook.NotCleared.selector, provider));
        _fundAs(jobId);
        assertEq(usdc.balanceOf(client), clientBefore);
    }

    function test_fund_aDesignatedClientStopsFunding() public {
        uint256 jobId = createJob(BUDGET, address(hook));
        _designate(client);
        _clear(provider);
        vm.expectRevert(abi.encodeWithSelector(SquareHook.NotCleared.selector, client));
        _fundAs(jobId);
    }

    function test_fund_bothPartiesHaveToBeCleared() public {
        uint256 jobId = createJob(BUDGET, address(hook));
        _clear(client);
        vm.expectRevert(abi.encodeWithSelector(SquareHook.NotCleared.selector, provider));
        _fundAs(jobId);
        _clear(provider);
        _fundAs(jobId);
        assertEq(uint8(kernel.getJobRecord(jobId).status), uint8(ISquareJob.JobStatus.Funded));
    }

    function test_fund_aScreeningPastItsMaxAgeIsNotEnough() public {
        uint256 jobId = createJob(BUDGET, address(hook));
        _clear(client);
        _clear(provider);
        vm.warp(vm.getBlockTimestamp() + MAX_AGE + 1);
        vm.expectRevert(abi.encodeWithSelector(SquareHook.NotCleared.selector, client));
        _fundAs(jobId);
    }

    // ---------------------------------------------------------------- release

    /// The honest path: the keeper has the payee screened again just before it
    /// finalizes, and the release goes through.
    function test_release_aPayeeScreenedJustBeforeFinalizeIsPaid() public {
        uint256 jobId = _submittedAndDue();
        _clear(provider);
        vm.expectEmit(true, true, false, true, address(hook));
        emit SquareHook.ScreeningChecked(jobId, provider, true);
        vm.prank(cranker);
        keeper.finalize(jobId);
        assertEq(kernel.withdrawable(provider), netOf(BUDGET));
        assertEq(kernel.withdrawable(client), 0);
    }

    /// #35's first criterion, at the second point: an address designated while
    /// the job ran is not paid, and the job still settles.
    function test_release_aPayeeDesignatedDuringTheJobIsNotPaid() public {
        uint256 jobId = _submittedAndDue();
        _designate(provider);
        vm.expectEmit(true, true, false, true, address(hook));
        emit SquareHook.ScreeningChecked(jobId, provider, false);
        vm.prank(cranker);
        keeper.finalize(jobId);
        assertEq(kernel.withdrawable(provider), 0, "not a unit to a designated payee");
        assertEq(kernel.withdrawable(client), netOf(BUDGET), "the net went back to the client");
        assertEq(uint8(kernel.getJobRecord(jobId).status), uint8(ISquareJob.JobStatus.Completed), "and it settled");
    }

    /// Fail-closed at release, and its cost, stated: a payee whose screening
    /// has aged out is not paid. The keeper re-screens before it finalizes to
    /// avoid this; anyone finalizing without doing so causes it.
    function test_release_aStaleScreeningIsARefusal() public {
        uint256 jobId = _submittedAndDue();
        assertFalse(screeningRegistry.isCleared(provider), "the funding-time screening has aged out");
        vm.prank(cranker);
        keeper.finalize(jobId);
        assertEq(kernel.withdrawable(provider), 0);
        assertEq(kernel.withdrawable(client), netOf(BUDGET));
    }

    /// A sold receivable pays its buyer, so the buyer is the payee screened at
    /// release.
    function test_release_aSoldClaimScreensTheBuyer() public {
        uint256 jobId = _submittedAndDue();
        vm.warp(keeper.challengeEndsAt(jobId) - 1);
        vm.prank(provider);
        market.list(jobId, uint64(900 * USDC));
        buyAs(buyer, jobId, uint64(900 * USDC));
        pastWindow(jobId);
        _clear(provider);
        _designate(buyer);
        vm.prank(cranker);
        keeper.finalize(jobId);
        assertEq(kernel.withdrawable(buyer), 0, "the designated buyer is not paid");
        assertEq(kernel.withdrawable(provider), 0);
        assertEq(kernel.withdrawable(client), netOf(BUDGET));
    }

    function test_release_aClearedBuyerIsPaid() public {
        uint256 jobId = _submittedAndDue();
        vm.warp(keeper.challengeEndsAt(jobId) - 1);
        vm.prank(provider);
        market.list(jobId, uint64(900 * USDC));
        buyAs(buyer, jobId, uint64(900 * USDC));
        pastWindow(jobId);
        _clear(buyer);
        vm.prank(cranker);
        keeper.finalize(jobId);
        assertEq(kernel.withdrawable(buyer), netOf(BUDGET));
    }

    /// A registry that cannot answer clears nobody, and the release is refused
    /// rather than stuck: the escrow lock #100 removed does not come back.
    function test_release_aRegistryThatRevertsIsARefusalNotALock() public {
        uint256 jobId = _submittedAndDue();
        vm.prank(owner);
        hook.setScreening(address(usdc)); // a contract with no isCleared
        vm.prank(cranker);
        keeper.finalize(jobId);
        assertEq(uint8(kernel.getJobRecord(jobId).status), uint8(ISquareJob.JobStatus.Completed));
        assertEq(kernel.withdrawable(client), netOf(BUDGET));
    }

    // --------------------------------------------------- the ERC-8004 record

    /// #35: the screening result is written to the ERC-8004 ValidationRegistry.
    /// The hook is the job's validator (the provider named it in its request),
    /// and its response is the gate's verdict on the release with a commitment
    /// to the screening record the verdict read. The exact call is asserted.
    function test_validation_aClearedReleaseIsAttestedWithItsScreening() public {
        uint256 jobId = _submittedAndDue();
        _clear(provider);
        bytes32 screening = keccak256(abi.encode(provider, screeningRegistry.screeningOf(provider)));
        bytes32 commitment = _evidence(jobId, provider, netOf(BUDGET), screening, 1);
        vm.expectCall(
            address(validation),
            abi.encodeCall(IValidationRegistry.validationResponse, (REQUEST_HASH, uint8(100), "", commitment, "square.settlement"))
        );
        vm.prank(cranker);
        keeper.finalize(jobId);
        (,, uint8 response,, string memory tag,) = validation.getValidationStatus(REQUEST_HASH);
        assertEq(response, 100, "a payee who was paid is attested as paid");
        assertEq(tag, "square.settlement");
        assertEq(kernel.withdrawable(provider), netOf(BUDGET), "and the commitment names what they received");
    }

    /// A designated payee: the release is refused, and the attestation says so,
    /// committing to the sanctioned record that refused it.
    function test_validation_aRefusedPayeeIsAttestedAsFailed() public {
        uint256 jobId = _submittedAndDue();
        _designate(provider);
        bytes32 screening = keccak256(abi.encode(provider, screeningRegistry.screeningOf(provider)));
        bytes32 commitment = _evidence(jobId, provider, 0, screening, 2);
        assertTrue(screeningRegistry.screeningOf(provider).sanctioned);
        vm.expectCall(
            address(validation),
            abi.encodeCall(IValidationRegistry.validationResponse, (REQUEST_HASH, uint8(0), "", commitment, "square.settlement"))
        );
        vm.prank(cranker);
        keeper.finalize(jobId);
        (,, uint8 response,,,) = validation.getValidationStatus(REQUEST_HASH);
        assertEq(response, 0, "the refusal is attested");
        assertEq(kernel.withdrawable(client), netOf(BUDGET));
    }

    /// With nothing installed, nothing is written: the record stays as it was.
    function test_validation_aSettlementWithNothingInstalledIsStillAttested() public {
        vm.prank(owner);
        hook.setScreening(address(0));
        uint256 jobId = createJob(BUDGET, address(hook));
        _fundAs(jobId);
        vm.prank(provider);
        kernel.submit(jobId, DELIVERABLE, abi.encode(AGENT_ID, REQUEST_HASH));
        pastWindow(jobId);

        vm.prank(cranker);
        keeper.finalize(jobId);

        (,, uint8 response,, string memory tag,) = validation.getValidationStatus(REQUEST_HASH);
        assertEq(response, 100, "the record says what settlement did, not what a check said");
        assertEq(tag, "square.settlement");
        (,,, bytes32 responseHash,,) = validation.getValidationStatus(REQUEST_HASH);
        assertEq(
            responseHash,
            _evidence(jobId, provider, netOf(BUDGET), bytes32(0), 0),
            "and it commits to the payee and the amount with no check installed"
        );
    }

    function _tagOf(bytes32 requestHash) internal view returns (string memory tag) {
        (,,,, tag,) = validation.getValidationStatus(requestHash);
    }

    // -------------------------------------------------------------- not gated

    /// A refund returns money to a client screened when it funded. Refusing it
    /// could only lock the money, so it is not screened.
    function test_claimRefundIsNotScreened() public {
        _clear(client);
        _clear(provider);
        uint256 jobId = createJob(BUDGET, address(hook));
        _fundAs(jobId);
        vm.warp(vm.getBlockTimestamp() + 1); // a newer screening than the one that cleared it
        _designate(client);
        vm.warp(kernel.getJobRecord(jobId).expiredAt);
        kernel.claimRefund(jobId);
        assertEq(kernel.withdrawable(client), BUDGET);
    }

    function test_removingTheRegistryRestoresTheUngatedPath() public {
        vm.prank(owner);
        hook.setScreening(address(0));
        assertEq(hook.screening(), address(0));
        uint256 jobId = createJob(BUDGET, address(hook));
        _fundAs(jobId);
        assertEq(uint8(kernel.getJobRecord(jobId).status), uint8(ISquareJob.JobStatus.Funded));
    }
}
