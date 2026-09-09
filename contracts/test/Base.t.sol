// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SquareJob} from "../src/SquareJob.sol";
import {KeeperEvaluator} from "../src/KeeperEvaluator.sol";
import {Arbitration} from "../src/Arbitration.sol";
import {ClaimMarket} from "../src/ClaimMarket.sol";
import {SquareHook} from "../src/SquareHook.sol";
import {ISquareJob} from "../src/interfaces/ISquareJob.sol";
import {IArbitration} from "../src/interfaces/IArbitration.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockIdentityRegistry, MockReputationRegistry, MockValidationRegistry} from "./mocks/MockRegistries.sol";
import {MockComplianceModule} from "./mocks/MockComplianceModule.sol";

abstract contract BaseTest is Test {
    uint256 internal constant USDC = 1e6;
    uint16 internal constant FULL_BPS = 10_000;
    uint16 internal constant PLATFORM_FEE_BP = 100;
    uint16 internal constant EVALUATOR_FEE_BP = 50;
    uint256 internal constant HOOK_GAS_LIMIT = 1_000_000;
    uint48 internal constant CHALLENGE_WINDOW = 1 days;
    uint48 internal constant DISPUTE_WINDOW = 3 days;
    uint48 internal constant FINALIZE_GRACE = 1 hours;
    uint16 internal constant BOND_BPS = 1_000;
    uint64 internal constant MIN_BOND = 1_000_000;
    uint64 internal constant MIN_REPUTATION_BUDGET = 1_000_000;

    MockUSDC internal usdc;
    MockIdentityRegistry internal identity;
    MockReputationRegistry internal reputation;
    MockValidationRegistry internal validation;
    MockComplianceModule internal compliance;

    SquareJob internal kernel;
    KeeperEvaluator internal keeper;
    Arbitration internal arbitration;
    ClaimMarket internal market;
    SquareHook internal hook;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal client = makeAddr("client");
    address internal provider = makeAddr("provider");
    address internal buyer = makeAddr("buyer");
    address internal cranker = makeAddr("cranker");
    address internal stranger = makeAddr("stranger");
    address internal arb1 = makeAddr("arb1");
    address internal arb2 = makeAddr("arb2");
    address internal arb3 = makeAddr("arb3");

    uint256 internal constant AGENT_ID = 892271;
    bytes32 internal constant REQUEST_HASH = keccak256("validation request");
    bytes32 internal constant DELIVERABLE = keccak256("deliverable");

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        usdc = new MockUSDC();
        identity = new MockIdentityRegistry();
        reputation = new MockReputationRegistry();
        validation = new MockValidationRegistry();
        compliance = new MockComplianceModule();

        kernel = new SquareJob(address(usdc), treasury, PLATFORM_FEE_BP, EVALUATOR_FEE_BP, HOOK_GAS_LIMIT, owner);
        keeper = new KeeperEvaluator(address(kernel), owner, CHALLENGE_WINDOW, DISPUTE_WINDOW, FINALIZE_GRACE);
        arbitration = new Arbitration(address(keeper), owner, BOND_BPS, MIN_BOND);
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

        vm.startPrank(owner);
        keeper.setArbitration(address(arbitration));
        kernel.setHookWhitelist(address(hook), true);
        address[] memory arbiters = new address[](3);
        arbiters[0] = arb1;
        arbiters[1] = arb2;
        arbiters[2] = arb3;
        arbitration.setArbiters(arbiters, 2);
        vm.stopPrank();

        identity.setAgent(AGENT_ID, provider, provider);
        vm.prank(provider);
        validation.validationRequest(address(hook), AGENT_ID, "", REQUEST_HASH);

        usdc.mint(client, 1_000_000 * USDC);
        usdc.mint(buyer, 1_000_000 * USDC);
        vm.prank(client);
        usdc.approve(address(kernel), type(uint256).max);
        vm.prank(client);
        usdc.approve(address(arbitration), type(uint256).max);
        vm.prank(buyer);
        usdc.approve(address(market), type(uint256).max);
    }

    function expiry() internal view returns (uint256) {
        return block.timestamp + 30 days;
    }

    function createJob(uint256 budget, address hookAddr) internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = kernel.createJob(provider, address(keeper), expiry(), "spec:0xabc", hookAddr);
        vm.prank(provider);
        kernel.setBudget(jobId, budget, "");
    }

    function fundedJob(uint256 budget, address hookAddr) internal returns (uint256 jobId) {
        jobId = createJob(budget, hookAddr);
        vm.prank(client);
        kernel.fund(jobId, budget, "");
    }

    function submittedJob(uint256 budget, address hookAddr) internal returns (uint256 jobId) {
        jobId = fundedJob(budget, hookAddr);
        vm.prank(provider);
        kernel.submit(jobId, DELIVERABLE, hookAddr == address(hook) ? abi.encode(AGENT_ID, REQUEST_HASH) : bytes(""));
    }

    function submittedHookedJob(uint256 budget) internal returns (uint256) {
        return submittedJob(budget, address(hook));
    }

    function pastWindow(uint256 jobId) internal {
        vm.warp(keeper.challengeEndsAt(jobId));
    }

    function text(uint256 length) internal pure returns (string memory) {
        bytes memory out = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            out[i] = "a";
        }
        return string(out);
    }

    function netOf(uint256 budget) internal pure returns (uint256) {
        return budget - (budget * PLATFORM_FEE_BP) / FULL_BPS - (budget * EVALUATOR_FEE_BP) / FULL_BPS;
    }

    function record(uint256 jobId) internal view returns (ISquareJob.JobRecord memory) {
        return kernel.getJobRecord(jobId);
    }

    function status(uint256 jobId) internal view returns (ISquareJob.JobStatus) {
        return kernel.getJobRecord(jobId).status;
    }

    function assertSolvent() internal view {
        uint256 escrowed;
        uint256 count = kernel.jobCounter();
        for (uint256 i = 1; i <= count; i++) {
            ISquareJob.JobRecord memory job = kernel.getJobRecord(i);
            if (job.status == ISquareJob.JobStatus.Funded || job.status == ISquareJob.JobStatus.Submitted) {
                escrowed += job.budget;
            }
        }
        assertGe(usdc.balanceOf(address(kernel)), escrowed + kernel.totalWithdrawable(), "kernel insolvent");
    }

    function vote(address arbiter, uint256 jobId, IArbitration.Outcome outcome, uint16 bps) internal {
        vm.prank(arbiter);
        arbitration.vote(jobId, outcome, bps);
    }
}
