// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test, stdJson, Vm} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IPolicyRegistry} from "../src/interfaces/IPolicyRegistry.sol";
import {SquareJob} from "../src/SquareJob.sol";
import {KeeperEvaluator} from "../src/KeeperEvaluator.sol";
import {ClaimMarket} from "../src/ClaimMarket.sol";
import {SquareHook} from "../src/SquareHook.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";
import {Groth16Verifier} from "../src/Groth16Verifier.sol";
import {ComplianceModule} from "../src/ComplianceModule.sol";
import {ISquareJob} from "../src/interfaces/ISquareJob.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockIdentityRegistry, MockReputationRegistry, MockValidationRegistry} from "./mocks/MockRegistries.sol";

/// The proof gate, against real proofs.
///
/// square#27. Nothing here is a mock of the compliance path: the verifier is the
/// contract in `src/`, the proofs are the ones `services/prover` produced into
/// `test/fixtures/proofs.json`, and the bindings are checked against a job the
/// kernel actually holds.
///
/// The fixtures fix six of the eight signals, so the job is built around them
/// rather than the other way round:
///
/// | Signal | Fixture | Made true by |
/// |---|---|---|
/// | `policy_data_hash` | `0x1609f1c0…02c3` | `setPolicy` from the client |
/// | `recipient` | `0x1111…1111` | the provider's address |
/// | `amount` | 5 000 000 | a budget of 5 076 141, which nets exactly that |
/// | `token` | `0x3600…0000` | the kernel's payment token, deployed there |
/// | `daily_spent_before` | 50 000 000 | the counter, moved before the job |
/// | `current_unix_timestamp` | 1 788 356 730 | `vm.warp` before `complete` |
///
/// A change to the fee constants breaks `setUp`'s assertion rather than silently
/// producing a job whose net payout no longer matches the proof.
contract ComplianceModuleTest is Test {
    using stdJson for string;

    uint16 internal constant FULL_BPS = 10_000;
    uint16 internal constant PLATFORM_FEE_BP = 100;
    uint16 internal constant EVALUATOR_FEE_BP = 50;
    uint256 internal constant HOOK_GAS_LIMIT = 1_000_000;
    uint48 internal constant CHALLENGE_WINDOW = 1 days;
    uint48 internal constant DISPUTE_WINDOW = 3 days;
    uint48 internal constant FINALIZE_GRACE = 1 hours;
    uint64 internal constant MIN_REPUTATION_BUDGET = 1_000_000;
    uint256 internal constant AGENT_ID = 1;
    bytes32 internal constant REQUEST_HASH = keccak256("request");
    bytes32 internal constant DELIVERABLE = keccak256("deliverable");

    // From test/fixtures/proofs.json, the `compliant` proof.
    address internal constant FIXTURE_TOKEN = 0x3600000000000000000000000000000000000000;
    address internal constant FIXTURE_RECIPIENT = 0x1111111111111111111111111111111111111111;
    uint256 internal constant FIXTURE_AMOUNT = 5_000_000;
    uint256 internal constant FIXTURE_SPENT_BEFORE = 50_000_000;
    uint256 internal constant FIXTURE_TIMESTAMP = 1_788_356_730;
    bytes32 internal constant FIXTURE_COMMITMENT =
        bytes32(uint256(0x1609f1c034cd93771030cdf76d5d5ff474397d8417da33ded98698aa5fbb02c3));

    /// The budget whose net payout is exactly the fixture's amount, after a 1%
    /// platform fee and a 0.5% evaluator fee taken with integer division.
    uint256 internal constant BUDGET = 5_076_141;

    uint64 internal constant TOLERANCE = 1 hours;
    uint128 internal constant DAILY_LIMIT = 100_000_000;

    MockUSDC internal usdc;
    MockIdentityRegistry internal identity;
    MockReputationRegistry internal reputation;
    MockValidationRegistry internal validation;
    SquareJob internal kernel;
    KeeperEvaluator internal keeper;
    ClaimMarket internal market;
    SquareHook internal hook;
    PolicyRegistry internal registry;
    Groth16Verifier internal verifier;
    ComplianceModule internal module;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal client = makeAddr("client");
    address internal buyer = makeAddr("buyer");
    address internal provider = FIXTURE_RECIPIENT;

    string internal fixtures;

    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
        uint256[8] input;
    }

    function setUp() public {
        // Twelve hours before the fixture's timestamp, and deliberately inside
        // the same UTC day. PolicyRegistry's counter resets lazily on
        // `timestamp / 86400`, so a setUp on the previous day would leave
        // `spentToday` at zero by the time the proof is presented and every
        // release would be refused on signal 5 for the wrong reason. The day
        // runs from 1 788 307 200 to 1 788 393 600.
        vm.warp(FIXTURE_TIMESTAMP - 12 hours);
        fixtures = vm.readFile("test/fixtures/proofs.json");

        // The kernel's payment token has to be the address the proof names.
        deployCodeTo("MockUSDC.sol:MockUSDC", FIXTURE_TOKEN);
        usdc = MockUSDC(FIXTURE_TOKEN);

        identity = new MockIdentityRegistry();
        reputation = new MockReputationRegistry();
        validation = new MockValidationRegistry();

        kernel = new SquareJob(FIXTURE_TOKEN, treasury, PLATFORM_FEE_BP, EVALUATOR_FEE_BP, HOOK_GAS_LIMIT, owner);
        keeper = new KeeperEvaluator(address(kernel), owner, CHALLENGE_WINDOW, DISPUTE_WINDOW, FINALIZE_GRACE);
        market = new ClaimMarket(address(kernel), address(keeper));
        hook = new SquareHook(
            address(kernel),
            address(market),
            address(identity),
            address(reputation),
            address(validation),
            owner,
            address(keeper),
            MIN_REPUTATION_BUDGET
        );
        registry = new PolicyRegistry(owner);
        verifier = new Groth16Verifier();
        module = new ComplianceModule(address(verifier), address(registry), address(kernel), owner, TOLERANCE);

        vm.startPrank(owner);
        kernel.setHookWhitelist(address(hook), true);
        hook.setComplianceModule(address(module));
        module.setHook(address(hook));
        registry.setSpender(address(module), true);
        registry.setSpender(address(this), true);
        vm.stopPrank();

        identity.setAgent(AGENT_ID, provider, provider);
        vm.prank(provider);
        validation.validationRequest(address(hook), AGENT_ID, "", REQUEST_HASH);

        usdc.mint(client, 1_000_000_000);
        usdc.mint(buyer, 1_000_000_000);
        vm.prank(client);
        usdc.approve(address(kernel), type(uint256).max);
        vm.prank(buyer);
        usdc.approve(address(market), type(uint256).max);

        // The policy, and the day already partly spent, exactly as the proof says.
        vm.prank(client);
        registry.setPolicy(FIXTURE_COMMITMENT, DAILY_LIMIT);
        registry.recordSpend(client, FIXTURE_SPENT_BEFORE);

        assertEq(netOf(BUDGET), FIXTURE_AMOUNT, "the budget no longer nets what the proof claims");
        assertEq(registry.spentToday(client), FIXTURE_SPENT_BEFORE, "counter not where the proof expects it");
    }

    // ------------------------------------------------------------------ helpers

    function netOf(uint256 budget) internal pure returns (uint256) {
        return budget - (budget * PLATFORM_FEE_BP) / FULL_BPS - (budget * EVALUATOR_FEE_BP) / FULL_BPS;
    }

    function _load(string memory key) internal view returns (Proof memory p) {
        uint256[] memory a = fixtures.readUintArray(string.concat(key, ".a"));
        uint256[] memory c = fixtures.readUintArray(string.concat(key, ".c"));
        uint256[] memory b0 = fixtures.readUintArray(string.concat(key, ".b[0]"));
        uint256[] memory b1 = fixtures.readUintArray(string.concat(key, ".b[1]"));
        uint256[] memory input = fixtures.readUintArray(string.concat(key, ".input"));
        p.a = [a[0], a[1]];
        p.b = [[b0[0], b0[1]], [b1[0], b1[1]]];
        p.c = [c[0], c[1]];
        for (uint256 i = 0; i < 8; i++) {
            p.input[i] = input[i];
        }
    }

    function encoded(Proof memory p) internal pure returns (bytes memory) {
        return abi.encode(p.a, p.b, p.c, p.input);
    }

    function compliantProof() internal view returns (bytes memory) {
        return encoded(_load(".compliant"));
    }

    /// What the module marks: `keccak256(abi.encode(publicSignals))`.
    function statementOf(bytes memory proof) internal pure returns (bytes32) {
        (,,, uint256[8] memory input) = abi.decode(proof, (uint256[2], uint256[2][2], uint256[2], uint256[8]));
        return keccak256(abi.encode(input));
    }

    function submittedJob() internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = kernel.createJob(provider, address(keeper), block.timestamp + 30 days, "spec:0xabc", address(hook));
        vm.prank(provider);
        kernel.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        kernel.fund(jobId, BUDGET, "");
        vm.prank(provider);
        kernel.submit(jobId, DELIVERABLE, abi.encode(AGENT_ID, REQUEST_HASH));
    }

    /// Move to the moment the proof was built for, then complete with it.
    function completeWith(uint256 jobId, bytes memory proof) internal {
        vm.warp(FIXTURE_TIMESTAMP);
        vm.prank(address(keeper));
        kernel.complete(jobId, bytes32(0), abi.encode(FULL_BPS, proof));
    }

    // ------------------------------------------------------- the happy path

    /// A valid proof releases to the provider and moves the counter.
    function test_validProofReleasesAndAdvancesTheCounter() public {
        uint256 jobId = submittedJob();
        completeWith(jobId, compliantProof());

        assertEq(uint8(kernel.getJobRecord(jobId).status), uint8(ISquareJob.JobStatus.Completed));
        assertEq(kernel.withdrawable(provider), FIXTURE_AMOUNT, "the provider is paid the net");
        assertEq(kernel.withdrawable(client), 0, "and the client keeps nothing back");
        assertEq(
            registry.spentToday(client),
            FIXTURE_SPENT_BEFORE + FIXTURE_AMOUNT,
            "the day advanced by what was released"
        );
    }

    /// The ERC-8004 validation record carries the verdict.
    function test_validProofWritesAPassingValidation() public {
        uint256 jobId = submittedJob();
        completeWith(jobId, compliantProof());
        (address responder, uint8 response,) = validation.responses(REQUEST_HASH);
        assertEq(responder, address(hook));
        assertEq(response, 100);
    }

    // ------------------------------------------------------- the refusal path

    /// No proof: the job settles, and the provider is paid nothing.
    ///
    /// Not a revert, deliberately. docs/decisions/hook-failure-modes.md: after
    /// #90 closed the refund on a submitted job under a horizon evaluator, a
    /// hook that reverted left the escrow with no exit at all.
    function test_completeWithoutAProofPaysTheProviderNothing() public {
        uint256 jobId = submittedJob();
        completeWith(jobId, "");

        assertEq(uint8(kernel.getJobRecord(jobId).status), uint8(ISquareJob.JobStatus.Completed), "still settles");
        assertEq(kernel.withdrawable(provider), 0);
        assertEq(kernel.withdrawable(client), FIXTURE_AMOUNT, "the net goes back to the client");
        assertEq(registry.spentToday(client), FIXTURE_SPENT_BEFORE, "and nothing was spent");
    }

    /// A proof that verifies but carries `is_compliant = 0`.
    ///
    /// The verifier accepts it — the circuit proves the checks ran, not that
    /// they passed — so refusing it is this module's job and nobody else's.
    function test_nonCompliantProofPaysTheProviderNothing() public {
        Proof memory blocked = _load(".blocked");
        assertEq(blocked.input[0], 0, "fixture should be the non-compliant one");
        assertTrue(verifier.verifyProof(blocked.a, blocked.b, blocked.c, blocked.input), "still a valid proof");

        uint256 jobId = submittedJob();
        completeWith(jobId, encoded(blocked));
        assertEq(kernel.withdrawable(provider), 0);
        assertEq(kernel.withdrawable(client), FIXTURE_AMOUNT);
    }

    /// Garbage in the proof slot is a refusal, not a revert.
    function test_malformedProofPaysTheProviderNothing() public {
        uint256 jobId = submittedJob();
        completeWith(jobId, hex"deadbeef");
        assertEq(uint8(kernel.getJobRecord(jobId).status), uint8(ISquareJob.JobStatus.Completed));
        assertEq(kernel.withdrawable(provider), 0);
    }

    // ------------------------------------------------------------- the bindings

    /// Every one of the eight public signals is bound to the job's own storage.
    ///
    /// Each case takes the real proof and moves the chain out from under one
    /// signal, which is the only way to test a binding without forging a proof:
    /// the pairing still passes, and the release still has to be refused.
    function test_everyPublicSignalIsBound() public {
        assertEq(module.boundSignalCount(), 8, "a signal was added without a binding");

        // 1. policy_data_hash — the client commits to a different policy
        uint256 jobId = submittedJob();
        vm.prank(client);
        registry.setPolicy(keccak256("some other policy"), DAILY_LIMIT);
        completeWith(jobId, compliantProof());
        assertEq(kernel.withdrawable(provider), 0, "policy_data_hash is not bound");
    }

    function test_binding_recipient() public {
        // The payee is resolved from the job, so a job whose provider is not the
        // fixture's recipient must be refused.
        address other = makeAddr("other provider");
        identity.setAgent(2, other, other);
        vm.prank(client);
        uint256 jobId = kernel.createJob(other, address(keeper), block.timestamp + 30 days, "spec", address(hook));
        vm.prank(other);
        kernel.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        kernel.fund(jobId, BUDGET, "");
        vm.prank(other);
        kernel.submit(jobId, DELIVERABLE, abi.encode(uint256(2), bytes32(0)));

        completeWith(jobId, compliantProof());
        assertEq(kernel.withdrawable(other), 0, "recipient is not bound");
        assertEq(kernel.withdrawable(client), FIXTURE_AMOUNT);
    }

    function test_binding_amount() public {
        // A split moves the amount the kernel will pay; the proof's signal 3
        // still claims the whole net.
        uint256 jobId = submittedJob();
        vm.warp(FIXTURE_TIMESTAMP);
        vm.prank(address(keeper));
        kernel.complete(jobId, bytes32(0), abi.encode(uint16(5_000), compliantProof()));
        assertEq(kernel.withdrawable(provider), 0, "amount is not bound");
    }

    function test_binding_dailySpentBefore() public {
        uint256 jobId = submittedJob();
        // Somebody else's payment lands first and moves the day.
        registry.recordSpend(client, 1);
        completeWith(jobId, compliantProof());
        assertEq(kernel.withdrawable(provider), 0, "daily_spent_before is not bound");
    }

    function test_binding_timestamp() public {
        uint256 jobId = submittedJob();
        vm.warp(FIXTURE_TIMESTAMP + TOLERANCE + 1);
        vm.prank(address(keeper));
        kernel.complete(jobId, bytes32(0), abi.encode(FULL_BPS, compliantProof()));
        assertEq(kernel.withdrawable(provider), 0, "the timestamp window is not enforced");
    }

    function test_binding_timestampAcceptsTheEdgeOfTheWindow() public {
        uint256 jobId = submittedJob();
        vm.warp(FIXTURE_TIMESTAMP + TOLERANCE);
        vm.prank(address(keeper));
        kernel.complete(jobId, bytes32(0), abi.encode(FULL_BPS, compliantProof()));
        assertEq(kernel.withdrawable(provider), FIXTURE_AMOUNT, "the edge of the window is inside it");
    }

    function test_binding_noPolicyIsRefused() public {
        address poor = makeAddr("client without a policy");
        usdc.mint(poor, 1_000_000_000);
        vm.prank(poor);
        usdc.approve(address(kernel), type(uint256).max);
        vm.prank(poor);
        uint256 jobId = kernel.createJob(provider, address(keeper), block.timestamp + 30 days, "spec", address(hook));
        vm.prank(provider);
        kernel.setBudget(jobId, BUDGET, "");
        vm.prank(poor);
        kernel.fund(jobId, BUDGET, "");
        vm.prank(provider);
        kernel.submit(jobId, DELIVERABLE, abi.encode(AGENT_ID, REQUEST_HASH));

        completeWith(jobId, compliantProof());
        assertEq(kernel.withdrawable(provider), 0, "a client with no policy cannot release");
        assertEq(kernel.withdrawable(poor), FIXTURE_AMOUNT);
    }

    // ----------------------------------------------------------------- replay

    /// The same proof cannot pay twice.
    ///
    /// Two mechanisms and either would do it here. The counter moved, so the
    /// second job's `daily_spent_before` no longer matches; and the proof is
    /// marked consumed. The second job is set up to be identical in every other
    /// respect, which is what makes this a replay rather than a mismatch.
    function test_theSameProofCannotBeUsedTwice() public {
        uint256 first = submittedJob();
        completeWith(first, compliantProof());
        assertEq(kernel.withdrawable(provider), FIXTURE_AMOUNT);
        // Keyed on the statement, not on the bytes: a Groth16 proof can be
        // re-randomised into different bytes for the same eight signals.
        assertTrue(module.isConsumed(statementOf(compliantProof())), "the statement is marked");

        uint256 second = submittedJob();
        completeWith(second, compliantProof());
        assertEq(kernel.withdrawable(provider), FIXTURE_AMOUNT, "the provider was paid a second time");
        assertEq(kernel.withdrawable(client), FIXTURE_AMOUNT, "the second net went back to the client");
    }

    /// The mark alone stops it, with the counter put back where it was.
    function test_theMarkStopsAReplayEvenWhenTheCounterAgrees() public {
        uint256 first = submittedJob();
        completeWith(first, compliantProof());

        // A fresh day resets the counter, so signal 5 would match again.
        vm.warp(FIXTURE_TIMESTAMP + 1 days);
        vm.prank(client);
        registry.setPolicy(FIXTURE_COMMITMENT, DAILY_LIMIT);
        registry.recordSpend(client, FIXTURE_SPENT_BEFORE);
        assertEq(registry.spentToday(client), FIXTURE_SPENT_BEFORE, "the counter is back where the proof wants it");

        uint256 second = submittedJob();
        vm.warp(FIXTURE_TIMESTAMP + 1 days);
        vm.prank(address(keeper));
        kernel.complete(second, bytes32(0), abi.encode(FULL_BPS, compliantProof()));
        assertEq(kernel.withdrawable(provider), FIXTURE_AMOUNT, "the mark did not stop the replay");
    }

    /// A re-randomised copy of a spent proof is refused, with nothing else left
    /// to refuse it.
    ///
    /// The review of #190 found the mark keyed on `keccak256(proof)`, and a
    /// Groth16 proof is not bound to its own encoding: for any r, s the triple
    /// (rA, r⁻¹B + sδ, C + rsA) verifies for the same signals.
    /// test/Malleability.t.sol shows src/Groth16Verifier.sol accepting exactly
    /// such a copy, so the premise is measured rather than argued.
    ///
    /// The counter closes most of the window. This test opens it on purpose --
    /// past midnight so the day resets, the counter put back where the proof
    /// wants it, and the tolerance widened so the timestamp still matches -- and
    /// then asserts the refusal comes from the mark by name. Keyed on the bytes,
    /// this paid the provider twice.
    function test_aRerandomisedCopyOfASpentProofIsRefused() public {
        bytes memory original = compliantProof();
        bytes memory copy = encoded(_load(".compliant_rerandomised"));

        assertEq(statementOf(copy), statementOf(original), "same statement");
        assertTrue(keccak256(copy) != keccak256(original), "different bytes");

        uint256 first = submittedJob();
        completeWith(first, original);
        assertEq(kernel.withdrawable(provider), FIXTURE_AMOUNT);

        // Just past midnight: the counter resets lazily on timestamp / 86400.
        uint256 nextDay = ((FIXTURE_TIMESTAMP / 1 days) + 1) * 1 days + 60;
        // Wide enough to still admit the proof's timestamp from the other side
        // of midnight. The gap is about ten hours with this fixture, which is
        // why a default tolerance does not reach.
        vm.prank(owner);
        module.setTimestampTolerance(11 hours);
        vm.warp(nextDay);

        // The new day starts at zero, so put it back where signal 5 expects it.
        vm.prank(client);
        registry.setPolicy(FIXTURE_COMMITMENT, DAILY_LIMIT);
        registry.recordSpend(client, FIXTURE_SPENT_BEFORE);
        assertEq(registry.spentToday(client), FIXTURE_SPENT_BEFORE, "the counter agrees with the proof again");

        assertFalse(
            module.previewRelease(first, provider, FIXTURE_AMOUNT, address(usdc), client, copy),
            "every other binding passes; only the mark can refuse this"
        );

        uint256 second = submittedJob();
        // Named, so the test cannot pass for a different reason later.
        vm.expectEmit(true, false, false, true, address(module));
        emit ComplianceModule.ReleaseRefused(second, "proof already used");
        vm.prank(address(keeper));
        kernel.complete(second, bytes32(0), abi.encode(FULL_BPS, copy));

        assertEq(kernel.withdrawable(provider), FIXTURE_AMOUNT, "the copy paid the provider a second time");
        assertEq(kernel.withdrawable(client), FIXTURE_AMOUNT, "the second net went back to the client");
        assertEq(registry.spentToday(client), FIXTURE_SPENT_BEFORE, "and moved no counter");
    }

    // --------------------------------------------------------- the sold claim

    /// A receivable that was sold pays its buyer, and the proof binds to them.
    ///
    /// #29. The payee is not the provider here, and binding signal 2 to the
    /// provider would refuse every proof on a sold claim — or bind to an address
    /// that is not the one being paid.
    function test_soldClaimBindsToTheBuyer() public {
        uint256 jobId = submittedJob();
        uint64 price = uint64(FIXTURE_AMOUNT / 2);
        vm.prank(provider);
        market.list(jobId, price);
        vm.prank(buyer);
        market.buy(jobId, price);
        assertEq(market.payeeOf(jobId), buyer, "the buyer is the payee");

        // The fixture's recipient is the provider, so a proof naming the provider
        // must now be refused: the money is going somewhere else.
        completeWith(jobId, compliantProof());
        assertEq(kernel.withdrawable(buyer), 0, "a proof for the provider paid the buyer");
        assertEq(kernel.withdrawable(client), FIXTURE_AMOUNT);
    }

    // ------------------------------------------------------------------- gas

    /// The whole gated completion fits, and each hook call fits its own cap.
    function test_gas_gatedCompleteFitsTheHookLimit() public {
        uint256 jobId = submittedJob();
        vm.warp(FIXTURE_TIMESTAMP);
        bytes memory proof = compliantProof();

        uint256 before = gasleft();
        vm.prank(address(keeper));
        kernel.complete(jobId, bytes32(0), abi.encode(FULL_BPS, proof));
        uint256 used = before - gasleft();
        emit log_named_uint("gas for a gated complete", used);

        // Two capped calls reach the module: resolvePayout previews, beforeAction
        // verifies again and writes. Each is capped at HOOK_GAS_LIMIT on its own,
        // which is what the criterion is about; the total is reported so a
        // regression in either shows up as a number.
        assertLt(used, 2 * HOOK_GAS_LIMIT + 400_000, "a gated complete outgrew its budget");
        assertEq(kernel.withdrawable(provider), FIXTURE_AMOUNT, "and it still released");
    }

    /// Each capped call has headroom on its own, which is the criterion.
    ///
    /// The total above is not the thing that can break: the kernel gives each
    /// hook call `hookGasLimit` and nothing more. A preview that ran out inside
    /// that cap would be caught and read as "not verified", so a valid proof
    /// would be refused and the client paid — a silent, expensive failure. This
    /// measures the two calls separately and asserts the margin.
    function test_gas_eachCappedCallHasHeadroom() public {
        uint256 jobId = submittedJob();
        vm.warp(FIXTURE_TIMESTAMP);
        bytes memory proof = compliantProof();
        bytes memory data = abi.encode(bytes32(0), abi.encode(FULL_BPS, proof));

        uint256 before = gasleft();
        hook.resolvePayout(jobId, data);
        uint256 preview = before - gasleft();
        emit log_named_uint("resolvePayout, with the preview", preview);

        before = gasleft();
        vm.prank(address(hook));
        module.checkRelease(
            jobId, provider, FIXTURE_AMOUNT, address(usdc), client, proof
        );
        uint256 check = before - gasleft();
        emit log_named_uint("checkRelease, verify plus the writes", check);

        assertLt(preview, HOOK_GAS_LIMIT / 2, "the preview has less than half the cap in hand");
        assertLt(check, HOOK_GAS_LIMIT / 2, "the check has less than half the cap in hand");
    }

    /// A module that cannot answer is a refusal, not a stuck job.
    ///
    /// The preview is specified never to revert and the hook wraps it anyway.
    /// This points the hook at a contract that is not a module at all.
    function test_anUnusableModuleRefusesRatherThanReverting() public {
        vm.prank(owner);
        hook.setComplianceModule(address(usdc));
        uint256 jobId = submittedJob();
        completeWith(jobId, compliantProof());
        assertEq(uint8(kernel.getJobRecord(jobId).status), uint8(ISquareJob.JobStatus.Completed), "still settles");
        assertEq(kernel.withdrawable(provider), 0);
        assertEq(kernel.withdrawable(client), FIXTURE_AMOUNT);
    }

    /// The refund path is never hooked, so the gate cannot strand an expiry.
    function test_claimRefundIsNotGated() public {
        vm.prank(client);
        uint256 jobId = kernel.createJob(provider, address(keeper), block.timestamp + 30 days, "spec", address(hook));
        vm.prank(provider);
        kernel.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        kernel.fund(jobId, BUDGET, "");

        vm.warp(block.timestamp + 31 days);
        vm.prank(client);
        kernel.claimRefund(jobId);
        assertEq(kernel.withdrawable(client), BUDGET, "a funded job refunds whole, with no proof anywhere");
    }

    // ------------------------------------------ the preview and the check agree

    // square#225. `previewRelease` sets the split and `checkRelease` does the
    // bookkeeping, inside a call the kernel tolerates. Any way for the second to
    // fail after the first said yes was a payment with nothing booked: the
    // counter unmoved, the mark rolled back with the revert, and the same proof
    // good for the next job. Against main before this change, each three-job
    // scenario below paid the provider 15 000 000 with `spentToday` unmoved and
    // `isConsumed` false.

    function _submittedJobOn(address hook_, string memory description) internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = kernel.createJob(provider, address(keeper), block.timestamp + 30 days, description, hook_);
        vm.prank(provider);
        kernel.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        kernel.fund(jobId, BUDGET, "");
        vm.prank(provider);
        kernel.submit(jobId, DELIVERABLE, "");
    }

    /// The rotation the issue names: a new hook pointed at the module, and the
    /// module not yet pointed at the new hook.
    function _hookPointedAtTheModule() internal returns (SquareHook next) {
        next = new SquareHook(
            address(kernel),
            address(market),
            address(identity),
            address(reputation),
            address(validation),
            owner,
            address(keeper),
            MIN_REPUTATION_BUDGET
        );
        vm.startPrank(owner);
        kernel.setHookWhitelist(address(next), true);
        next.setComplianceModule(address(module));
        vm.stopPrank();
    }

    function _count(Vm.Log[] memory logs, address emitter, bytes32 topic) internal pure returns (uint256 n) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == emitter && logs[i].topics[0] == topic) n++;
        }
    }

    /// Acceptance: while the registry does not list the module, the preview says no.
    function test_previewRefusesWhileTheModuleIsNotASpender() public {
        uint256 jobId = submittedJob();
        vm.warp(FIXTURE_TIMESTAMP);
        bytes memory proof = compliantProof();
        assertTrue(
            module.previewRelease(jobId, provider, FIXTURE_AMOUNT, address(usdc), client, proof),
            "the same release previews true while the module is listed"
        );

        vm.prank(owner);
        registry.setSpender(address(module), false);
        assertFalse(
            module.previewRelease(jobId, provider, FIXTURE_AMOUNT, address(usdc), client, proof),
            "the preview passed a release recordSpend would refuse"
        );
    }

    /// Acceptance: in the same state `complete` pays the provider nothing, and
    /// the refusal is named rather than swallowed.
    function test_completePaysNothingWhileTheModuleIsNotASpender() public {
        vm.prank(owner);
        registry.setSpender(address(module), false);
        uint256 jobId = submittedJob();
        vm.warp(FIXTURE_TIMESTAMP);

        vm.recordLogs();
        vm.expectEmit(true, false, false, true, address(module));
        emit ComplianceModule.ReleaseRefused(jobId, "not a spender");
        vm.prank(address(keeper));
        kernel.complete(jobId, bytes32(0), abi.encode(FULL_BPS, compliantProof()));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(kernel.withdrawable(provider), 0, "the provider was paid on a release nothing could book");
        assertEq(kernel.withdrawable(client), FIXTURE_AMOUNT, "the net went back to the client");
        assertEq(registry.spentToday(client), FIXTURE_SPENT_BEFORE, "and nothing was spent");
        assertEq(
            _count(logs, address(hook), SquareHook.ComplianceCheckFailed.selector), 0, "the check answered, not reverted"
        );
        assertEq(
            _count(logs, address(hook), SquareHook.ReleaseUnconfirmed.selector), 0, "a refusal is not an unconfirmed payment"
        );
    }

    /// Acceptance: the same proof is not accepted on a second job while the
    /// counter stands still -- here, on any of three. Once the registry lists
    /// the module again, the proof pays exactly once.
    function test_theSameProofPaysNoJobWhileTheCounterStandsStill() public {
        bytes memory proof = compliantProof();
        vm.prank(owner);
        registry.setSpender(address(module), false);
        for (uint256 i = 0; i < 3; i++) {
            completeWith(submittedJob(), proof);
        }
        assertEq(kernel.withdrawable(provider), 0, "the provider was paid on a release nothing could book");
        assertEq(kernel.withdrawable(client), 3 * FIXTURE_AMOUNT, "each net went back to the client");
        assertEq(registry.spentToday(client), FIXTURE_SPENT_BEFORE, "the counter did not move");
        assertFalse(module.isConsumed(statementOf(proof)), "nothing was paid, so nothing was spent");

        vm.prank(owner);
        registry.setSpender(address(module), true);
        completeWith(submittedJob(), proof);
        assertEq(kernel.withdrawable(provider), FIXTURE_AMOUNT, "listed again, the proof pays");
        assertEq(registry.spentToday(client), FIXTURE_SPENT_BEFORE + FIXTURE_AMOUNT, "and is booked");
        assertTrue(module.isConsumed(statementOf(proof)), "and is spent");

        completeWith(submittedJob(), proof);
        assertEq(kernel.withdrawable(provider), FIXTURE_AMOUNT, "and pays only once");
    }

    /// Acceptance, the literal case: a spend the registry refuses after the
    /// preview has paid still spends the proof, so the next job is refused by
    /// the mark alone with the counter exactly where the proof wants it.
    ///
    /// No real path reaches this any more -- the preview now checks everything
    /// `recordSpend` reverts on -- so the registry's refusal is injected with
    /// `vm.mockCallRevert`, carrying the `NotASpender` the issue measured. It is
    /// the line behind the preview, and a line nobody can reach is still one
    /// somebody has to show holds.
    function test_aSpendTheRegistryRefusesStillSpendsTheProof() public {
        bytes memory proof = compliantProof();
        uint256 first = submittedJob();
        vm.warp(FIXTURE_TIMESTAMP);

        vm.mockCallRevert(
            address(registry),
            abi.encodeWithSelector(PolicyRegistry.recordSpend.selector),
            abi.encodeWithSelector(IPolicyRegistry.NotASpender.selector, address(module))
        );
        vm.expectEmit(true, false, false, true, address(module));
        emit ComplianceModule.ReleaseRefused(first, "spend not recorded");
        vm.expectEmit(true, true, false, true, address(hook));
        emit SquareHook.ReleaseUnconfirmed(first, provider, FIXTURE_AMOUNT);
        vm.prank(address(keeper));
        kernel.complete(first, bytes32(0), abi.encode(FULL_BPS, proof));
        vm.clearMockedCalls();

        assertEq(kernel.withdrawable(provider), FIXTURE_AMOUNT, "the preview had already paid");
        assertEq(registry.spentToday(client), FIXTURE_SPENT_BEFORE, "the counter did not move");
        assertTrue(module.isConsumed(statementOf(proof)), "the mark went back with the failed spend");

        uint256 second = submittedJob();
        vm.warp(FIXTURE_TIMESTAMP);
        vm.expectEmit(true, false, false, true, address(module));
        emit ComplianceModule.ReleaseRefused(second, "proof already used");
        vm.prank(address(keeper));
        kernel.complete(second, bytes32(0), abi.encode(FULL_BPS, proof));
        assertEq(kernel.withdrawable(provider), FIXTURE_AMOUNT, "the same proof paid a second job");
        assertEq(kernel.withdrawable(client), FIXTURE_AMOUNT, "the second net went back to the client");
    }

    /// Acceptance: the zero address is not a hook.
    function test_setHookRefusesTheZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(ComplianceModule.ZeroAddress.selector);
        module.setHook(address(0));
        assertEq(module.hook(), address(hook), "and the hook it had is kept");
    }

    /// The first gate the issue names: a hook rotated in without `setHook`.
    /// Its jobs preview false and pay nothing, where before they paid and the
    /// check reverted `OnlyHook`. Finishing the rotation pays, once.
    function test_aHookTheModuleDoesNotAuthoriseIsPaidNothing() public {
        SquareHook next = _hookPointedAtTheModule();
        bytes memory proof = compliantProof();
        for (uint256 i = 0; i < 3; i++) {
            uint256 jobId = _submittedJobOn(address(next), "spec:0xabc");
            vm.warp(FIXTURE_TIMESTAMP);
            assertFalse(
                module.previewRelease(jobId, provider, FIXTURE_AMOUNT, address(usdc), client, proof),
                "the preview passed a release the job's hook cannot book"
            );
            vm.prank(address(keeper));
            kernel.complete(jobId, bytes32(0), abi.encode(FULL_BPS, proof));
        }
        assertEq(kernel.withdrawable(provider), 0, "the provider was paid through a hook the module refuses");
        assertEq(kernel.withdrawable(client), 3 * FIXTURE_AMOUNT, "each net went back to the client");
        assertEq(registry.spentToday(client), FIXTURE_SPENT_BEFORE, "the counter did not move");
        assertFalse(module.isConsumed(statementOf(proof)), "nothing was paid, so nothing was spent");

        vm.prank(owner);
        module.setHook(address(next));
        uint256 rotated = _submittedJobOn(address(next), "spec:0xabc");
        vm.warp(FIXTURE_TIMESTAMP);
        vm.prank(address(keeper));
        kernel.complete(rotated, bytes32(0), abi.encode(FULL_BPS, proof));
        assertEq(kernel.withdrawable(provider), FIXTURE_AMOUNT, "the rotated hook books its release");
        assertEq(registry.spentToday(client), FIXTURE_SPENT_BEFORE + FIXTURE_AMOUNT);
        assertTrue(module.isConsumed(statementOf(proof)));
    }

    /// The other side of a rotation: a job still on the hook rotated away from
    /// fails closed rather than paying a release its old hook cannot book.
    function test_aJobOnTheHookRotatedAwayFromIsPaidNothing() public {
        uint256 jobId = submittedJob();
        SquareHook next = _hookPointedAtTheModule();
        vm.prank(owner);
        module.setHook(address(next));

        completeWith(jobId, compliantProof());
        assertEq(kernel.withdrawable(provider), 0, "the old hook's job was paid with nothing booked");
        assertEq(kernel.withdrawable(client), FIXTURE_AMOUNT);
        assertEq(registry.spentToday(client), FIXTURE_SPENT_BEFORE);
    }

    /// The preview is specified never to revert, and the hook binding reads
    /// the job: a job that does not exist is a `false`.
    function test_previewAnswersFalseForAJobThatDoesNotExist() public {
        vm.warp(FIXTURE_TIMESTAMP);
        assertFalse(
            module.previewRelease(type(uint256).max, provider, FIXTURE_AMOUNT, address(usdc), client, compliantProof())
        );
    }

    /// A module nobody has pointed at a hook yet authorises none of them, so the
    /// preview refuses rather than passing a release that nothing can book.
    function test_previewRefusesBeforeTheModuleHasAHook() public {
        ComplianceModule fresh =
            new ComplianceModule(address(verifier), address(registry), address(kernel), owner, TOLERANCE);
        assertEq(fresh.hook(), address(0), "a new module authorises no hook");
        uint256 jobId = submittedJob();
        vm.warp(FIXTURE_TIMESTAMP);
        assertFalse(
            fresh.previewRelease(jobId, provider, FIXTURE_AMOUNT, address(usdc), client, compliantProof()),
            "a module with no hook passed a release"
        );
    }

    // ---------------------------------------------------- the gas floor, #225

    function _coolStack() internal {
        vm.cool(address(kernel));
        vm.cool(address(keeper));
        vm.cool(address(market));
        vm.cool(address(hook));
        vm.cool(address(module));
        vm.cool(address(registry));
        vm.cool(address(verifier));
        vm.cool(address(usdc));
        vm.cool(address(identity));
        vm.cool(address(reputation));
        vm.cool(address(validation));
    }

    /// The least hook budget at which the preview passes (`booking` false) or
    /// the check books the release (`booking` true), with every slot cold.
    function _leastHookGas(uint256 jobId, bytes memory data, bool booking) internal returns (uint256 hi) {
        bytes32 statement = statementOf(compliantProof());
        uint256 lo = 0;
        hi = HOOK_GAS_LIMIT;
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            uint256 snapshot = vm.snapshotState();
            _coolStack();
            bool done;
            if (booking) {
                vm.prank(address(kernel));
                (bool ok,) = address(hook).call{gas: mid}(
                    abi.encodeCall(hook.beforeAction, (jobId, ISquareJob.complete.selector, data))
                );
                done = ok && module.isConsumed(statement)
                    && registry.spentToday(client) == FIXTURE_SPENT_BEFORE + FIXTURE_AMOUNT;
            } else {
                (bool ok, bytes memory ret) =
                    address(hook).call{gas: mid}(abi.encodeCall(hook.resolvePayout, (jobId, data)));
                if (ok) {
                    (, uint16 bps) = abi.decode(ret, (address, uint16));
                    done = bps == FULL_BPS;
                }
            }
            vm.revertToState(snapshot);
            if (done) hi = mid;
            else lo = mid;
        }
    }

    /// What a poster's first-ever spend adds to `recordSpend`: a zero slot
    /// written rather than a live one. The fixtures cannot show it through the
    /// gate -- every proof carries a counter of 50 000 000 -- so it is measured
    /// on the registry directly.
    function _firstSpendSurcharge() internal returns (uint256) {
        uint256 snapshot = vm.snapshotState();
        address fresh = makeAddr("first-time poster");
        vm.prank(fresh);
        registry.setPolicy(FIXTURE_COMMITMENT, DAILY_LIMIT);
        _coolStack();
        uint256 g0 = gasleft();
        registry.recordSpend(fresh, FIXTURE_AMOUNT);
        uint256 first = g0 - gasleft();
        _coolStack();
        g0 = gasleft();
        registry.recordSpend(client, FIXTURE_AMOUNT);
        uint256 later = g0 - gasleft();
        vm.revertToState(snapshot);
        return first - later;
    }

    /// A kernel whose limit sits below the check cannot carry the module.
    function test_aKernelUnderTheFloorCannotCarryTheModule() public {
        uint256 floor = module.MIN_HOOK_GAS_LIMIT();
        SquareJob narrow = new SquareJob(FIXTURE_TOKEN, treasury, PLATFORM_FEE_BP, EVALUATOR_FEE_BP, floor - 1, owner);
        vm.expectRevert(abi.encodeWithSelector(ComplianceModule.HookGasLimitTooLow.selector, floor - 1, floor));
        new ComplianceModule(address(verifier), address(registry), address(narrow), owner, TOLERANCE);

        SquareJob enough = new SquareJob(FIXTURE_TOKEN, treasury, PLATFORM_FEE_BP, EVALUATOR_FEE_BP, floor, owner);
        ComplianceModule fits = new ComplianceModule(address(verifier), address(registry), address(enough), owner, TOLERANCE);
        assertEq(fits.squareJob(), address(enough));
    }

    /// The floor is a measurement, so it is measured here on every run: the
    /// least budget at which the check books, cold, on the longest description
    /// the kernel accepts, plus a first-ever spend, has to sit inside it. And
    /// the gap the issue measured has to be there, or the floor is guarding
    /// nothing and wants re-measuring.
    function test_theFloorCoversTheCheck() public {
        // Gas is a property of the optimised bytecode that gets deployed.
        // `forge coverage` builds without the optimiser, so its figures are not
        // these; the floor is checked by `forge test`.
        if (vm.isContext(VmSafe.ForgeContext.Coverage)) return;

        bytes memory description = new bytes(256);
        for (uint256 i = 0; i < description.length; i++) {
            description[i] = "x";
        }
        uint256 jobId = _submittedJobOn(address(hook), string(description));
        vm.warp(FIXTURE_TIMESTAMP);
        bytes memory data = abi.encode(bytes32(0), abi.encode(FULL_BPS, compliantProof()));

        uint256 preview = _leastHookGas(jobId, data, false);
        uint256 check = _leastHookGas(jobId, data, true);
        uint256 firstSpend = _firstSpendSurcharge();
        emit log_named_uint("least hook gas for the preview to pass", preview);
        emit log_named_uint("least hook gas for the check to book", check);
        emit log_named_uint("added by a poster's first-ever spend", firstSpend);
        emit log_named_uint("MIN_HOOK_GAS_LIMIT", module.MIN_HOOK_GAS_LIMIT());

        assertLt(preview, check, "the check no longer costs more than the preview; re-measure the floor");
        assertLe(check + firstSpend, module.MIN_HOOK_GAS_LIMIT(), "the check outgrew the floor");
    }

    /// 0 reverted, 1 completed and refused, 2 paid and booked, 3 paid and not booked.
    function _completeUnder(uint256 jobId, bytes memory optParams, uint256 gas) internal returns (uint8 outcome) {
        uint256 snapshot = vm.snapshotState();
        _coolStack();
        vm.prank(address(keeper));
        (bool ok,) = address(kernel).call{gas: gas}(abi.encodeCall(kernel.complete, (jobId, bytes32(0), optParams)));
        if (!ok) outcome = 0;
        else if (kernel.withdrawable(provider) == 0) outcome = 1;
        else if (
            module.isConsumed(statementOf(compliantProof()))
                && registry.spentToday(client) == FIXTURE_SPENT_BEFORE + FIXTURE_AMOUNT
        ) outcome = 2;
        else outcome = 3;
        vm.revertToState(snapshot);
    }

    /// The limit is the thing to floor, not the caller's gas. `finalize` is
    /// permissionless, so whoever sends it picks the gas; this sweeps that pick
    /// from well under one hook call to past the point where the kernel keeps
    /// enough to settle on 1/64 of it, and no pick pays a release unbooked.
    function test_noCallerGasPaysWithoutBooking() public {
        uint256 jobId = submittedJob();
        vm.warp(FIXTURE_TIMESTAMP);
        bytes memory optParams = abi.encode(FULL_BPS, compliantProof());
        uint256[4] memory count;
        for (uint256 gas = 250_000; gas <= 2_600_000; gas += 10_000) {
            count[_completeUnder(jobId, optParams, gas)]++;
        }
        emit log_named_uint("reverted whole", count[0]);
        emit log_named_uint("completed, provider refused", count[1]);
        emit log_named_uint("completed, paid and booked", count[2]);
        emit log_named_uint("completed, paid and not booked", count[3]);
        assertEq(count[3], 0, "a caller's gas limit paid a release the check did not book");
        assertGt(count[2], 0, "nothing in the sweep settled, so it showed nothing");
    }
}
