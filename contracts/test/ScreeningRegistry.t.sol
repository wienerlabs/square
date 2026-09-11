// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ScreeningRegistry} from "../src/ScreeningRegistry.sol";
import {IScreeningRegistry} from "../src/interfaces/IScreeningRegistry.sol";

/// The registry the hook reads at funding and at release. square#35.
///
/// A screening here is what services/screener produces: the source's answer
/// for one address, the time it answered, the source's name, and the hash of
/// its raw response body, signed under EIP-712. The response bodies below have
/// the shape TRM's API returns, `[{"address": …, "isSanctioned": …}]`.
contract ScreeningRegistryTest is Test {
    ScreeningRegistry internal registry;

    address internal owner = makeAddr("owner");
    address internal screener;
    uint256 internal screenerKey;
    address internal stranger;
    uint256 internal strangerKey;
    address internal subject = makeAddr("subject");

    uint64 internal constant MAX_AGE = 1 hours;
    bytes32 internal constant SOURCE = "trm-sanctions-v1";

    function setUp() public {
        vm.warp(1_788_356_730);
        (screener, screenerKey) = makeAddrAndKey("screener");
        (stranger, strangerKey) = makeAddrAndKey("stranger");
        registry = new ScreeningRegistry(owner, MAX_AGE);
        vm.prank(owner);
        registry.setScreener(screener, true);
    }

    function _screening(address who, bool sanctioned, uint64 at) internal pure returns (IScreeningRegistry.Screening memory) {
        bytes memory body = abi.encodePacked(
            '[{"address":"', vm.toString(who), '","isSanctioned":', sanctioned ? "true" : "false", "}]"
        );
        return IScreeningRegistry.Screening(who, sanctioned, at, SOURCE, keccak256(body));
    }

    function _sign(uint256 key, IScreeningRegistry.Screening memory s) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 sig) = vm.sign(key, registry.digestOf(s));
        return abi.encodePacked(r, sig, v);
    }

    function _submit(address who, bool sanctioned, uint64 at) internal {
        IScreeningRegistry.Screening memory s = _screening(who, sanctioned, at);
        registry.submit(s, _sign(screenerKey, s));
    }

    function _now() internal view returns (uint64) {
        return uint64(block.timestamp);
    }

    // ------------------------------------------------------------- the rule

    /// Empty means nobody is cleared: the case covenant's empty denylist got
    /// wrong, where an absent list read as a clean one.
    function test_anEmptyRegistryClearsNobody() public view {
        assertFalse(registry.isCleared(subject));
        assertFalse(registry.isCleared(screener), "not even the screener itself");
        assertEq(registry.screeningOf(subject).screenedAt, 0);
    }

    function test_aCleanScreeningClearsUntilItAges() public {
        _submit(subject, false, _now());
        assertTrue(registry.isCleared(subject));
        vm.warp(block.timestamp + MAX_AGE);
        assertTrue(registry.isCleared(subject), "good for exactly maxAge");
        vm.warp(block.timestamp + 1);
        assertFalse(registry.isCleared(subject), "and not a second more");
    }

    function test_aSanctionedScreeningDoesNotClear() public {
        _submit(subject, true, _now());
        assertFalse(registry.isCleared(subject));
        IScreeningRegistry.Record memory r = registry.screeningOf(subject);
        assertTrue(r.sanctioned);
        assertEq(r.screener, screener);
        assertEq(r.source, SOURCE);
    }

    function test_theRecordCarriesWhatAnswered() public {
        IScreeningRegistry.Screening memory s = _screening(subject, false, _now());
        vm.expectEmit(true, true, true, true, address(registry));
        emit IScreeningRegistry.Screened(subject, false, s.screenedAt, SOURCE, s.evidence, screener);
        registry.submit(s, _sign(screenerKey, s));
        assertEq(registry.screeningOf(subject).evidence, s.evidence);
    }

    // ------------------------------------------------------- who is trusted

    function test_onlyARegisteredScreenersSignatureCounts() public {
        IScreeningRegistry.Screening memory s = _screening(subject, false, _now());
        bytes memory signature = _sign(strangerKey, s);
        vm.expectRevert(abi.encodeWithSelector(IScreeningRegistry.NotAScreener.selector, stranger));
        registry.submit(s, signature);
    }

    /// The signature is what is trusted, not the sender.
    function test_anyoneMaySubmitASignedScreening() public {
        IScreeningRegistry.Screening memory s = _screening(subject, false, _now());
        bytes memory signature = _sign(screenerKey, s);
        vm.prank(stranger);
        registry.submit(s, signature);
        assertTrue(registry.isCleared(subject));
    }

    function test_revokingAScreenerRevokesWhatItSigned() public {
        _submit(subject, false, _now());
        assertTrue(registry.isCleared(subject));
        vm.prank(owner);
        registry.setScreener(screener, false);
        assertFalse(registry.isCleared(subject), "a compromised screener's records stop counting at once");
    }

    function test_aSignatureOverAnotherFieldDoesNotVerify() public {
        IScreeningRegistry.Screening memory s = _screening(subject, true, _now());
        bytes memory signature = _sign(screenerKey, s);
        s.sanctioned = false; // flipped after signing
        vm.expectRevert();
        registry.submit(s, signature);
        assertFalse(registry.isCleared(subject));
    }

    /// The domain binds the chain and the registry: a screening signed for one
    /// is not a screening for the other.
    function test_theDomainBindsTheRegistryAndTheChain() public {
        ScreeningRegistry other = new ScreeningRegistry(owner, MAX_AGE);
        IScreeningRegistry.Screening memory s = _screening(subject, false, _now());
        (uint8 v, bytes32 r, bytes32 sig) = vm.sign(screenerKey, other.digestOf(s));
        vm.expectRevert();
        registry.submit(s, abi.encodePacked(r, sig, v));

        bytes memory here = _sign(screenerKey, s);
        vm.chainId(block.chainid + 1);
        vm.expectRevert();
        registry.submit(s, here);
    }

    function test_aMalformedSignatureIsRefused() public {
        IScreeningRegistry.Screening memory s = _screening(subject, false, _now());
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 64));
        registry.submit(s, new bytes(64));
    }

    // ------------------------------------------------------------------ time

    /// A "cleared" kept back from before a designation cannot overwrite it.
    function test_anOlderScreeningCannotOverwriteANewerOne() public {
        uint64 before = _now();
        vm.warp(block.timestamp + 10 minutes);
        _submit(subject, true, _now());
        IScreeningRegistry.Screening memory stale = _screening(subject, false, before);
        bytes memory signature = _sign(screenerKey, stale);
        vm.expectRevert(
            abi.encodeWithSelector(IScreeningRegistry.NotNewerThanRecorded.selector, subject, before, _now())
        );
        registry.submit(stale, signature);

        IScreeningRegistry.Screening memory same = _screening(subject, false, _now());
        signature = _sign(screenerKey, same);
        vm.expectRevert(
            abi.encodeWithSelector(IScreeningRegistry.NotNewerThanRecorded.selector, subject, _now(), _now())
        );
        registry.submit(same, signature);
        assertFalse(registry.isCleared(subject));
    }

    /// A delisting is a newer screening, and it replaces the record.
    function test_aNewerScreeningReplacesTheRecord() public {
        _submit(subject, true, _now());
        vm.warp(block.timestamp + 1);
        _submit(subject, false, _now());
        assertTrue(registry.isCleared(subject));
    }

    function test_screeningsFromTheFutureOrTooLongAgoAreRefused() public {
        IScreeningRegistry.Screening memory future = _screening(subject, false, _now() + 1);
        bytes memory signature = _sign(screenerKey, future);
        vm.expectRevert(
            abi.encodeWithSelector(IScreeningRegistry.ScreenedInTheFuture.selector, _now() + 1, block.timestamp)
        );
        registry.submit(future, signature);

        uint64 old = _now() - MAX_AGE - 1;
        IScreeningRegistry.Screening memory stale = _screening(subject, false, old);
        signature = _sign(screenerKey, stale);
        vm.expectRevert(abi.encodeWithSelector(IScreeningRegistry.ScreeningTooOld.selector, old, MAX_AGE));
        registry.submit(stale, signature);
    }

    // ---------------------------------------------------------------- batches

    function test_submitManyIsAllOrNothing() public {
        address second = makeAddr("second");
        IScreeningRegistry.Screening[] memory list = new IScreeningRegistry.Screening[](2);
        bytes[] memory signatures = new bytes[](2);
        list[0] = _screening(subject, false, _now());
        list[1] = _screening(second, false, _now());
        signatures[0] = _sign(screenerKey, list[0]);
        signatures[1] = _sign(strangerKey, list[1]);
        vm.expectRevert(abi.encodeWithSelector(IScreeningRegistry.NotAScreener.selector, stranger));
        registry.submitMany(list, signatures);
        assertFalse(registry.isCleared(subject), "the first was not kept either");

        signatures[1] = _sign(screenerKey, list[1]);
        registry.submitMany(list, signatures);
        assertTrue(registry.isCleared(subject) && registry.isCleared(second));

        vm.expectRevert(IScreeningRegistry.LengthMismatch.selector);
        registry.submitMany(list, new bytes[](1));
    }

    function test_theZeroAddressIsNotASubject() public {
        IScreeningRegistry.Screening memory s = _screening(address(0), false, _now());
        bytes memory signature = _sign(screenerKey, s);
        vm.expectRevert(IScreeningRegistry.ZeroAddress.selector);
        registry.submit(s, signature);
    }

    // --------------------------------------------------------- administration

    function test_maxAgeIsBoundedAndOwnerOnly() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IScreeningRegistry.MaxAgeOutOfRange.selector, uint64(59)));
        registry.setMaxAge(59);
        vm.expectRevert(abi.encodeWithSelector(IScreeningRegistry.MaxAgeOutOfRange.selector, uint64(7 days + 1)));
        registry.setMaxAge(7 days + 1);
        registry.setMaxAge(2 hours);
        vm.stopPrank();
        assertEq(registry.maxAge(), 2 hours);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        registry.setMaxAge(1 hours);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        registry.setScreener(stranger, true);
        vm.expectRevert(IScreeningRegistry.ZeroAddress.selector);
        vm.prank(owner);
        registry.setScreener(address(0), true);
        vm.expectRevert(IScreeningRegistry.RenounceDisabled.selector);
        vm.prank(owner);
        registry.renounceOwnership();
    }

    function test_aConstructorMaxAgeOutOfRangeIsRefused() public {
        vm.expectRevert(abi.encodeWithSelector(IScreeningRegistry.MaxAgeOutOfRange.selector, uint64(0)));
        new ScreeningRegistry(owner, 0);
    }
}
