// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BaseTest} from "../Base.t.sol";
import {SquareJob} from "../../src/SquareJob.sol";
import {KeeperEvaluator} from "../../src/KeeperEvaluator.sol";
import {Arbitration} from "../../src/Arbitration.sol";
import {ISquareJob} from "../../src/interfaces/ISquareJob.sol";
import {IArbitration} from "../../src/interfaces/IArbitration.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

contract ArbitrationHandler is Test {
    SquareJob internal kernel;
    KeeperEvaluator internal keeper;
    Arbitration internal arbitration;
    MockUSDC internal usdc;
    address internal hook;
    address internal client;
    address internal provider;
    address internal cranker;
    address[3] internal arbiters;
    uint256 internal agentId;
    bytes32 internal requestHash;

    uint256[] public jobIds;
    uint256 public opened;
    uint256 public decided;
    uint256 public lapsed;
    uint256 public finalized;
    uint256 public settledByAnyone;

    constructor(
        SquareJob kernel_,
        KeeperEvaluator keeper_,
        Arbitration arbitration_,
        MockUSDC usdc_,
        address hook_,
        address client_,
        address provider_,
        address cranker_,
        address[3] memory arbiters_,
        uint256 agentId_,
        bytes32 requestHash_
    ) {
        kernel = kernel_;
        keeper = keeper_;
        arbitration = arbitration_;
        usdc = usdc_;
        hook = hook_;
        client = client_;
        provider = provider_;
        cranker = cranker_;
        arbiters = arbiters_;
        agentId = agentId_;
        requestHash = requestHash_;
    }

    function count() external view returns (uint256) {
        return jobIds.length;
    }

    function openDispute(uint96 budgetSeed) external {
        uint256 budget = bound(uint256(budgetSeed), 2_000_000, 1_000_000_000);
        vm.prank(client);
        uint256 jobId = kernel.createJob(provider, address(keeper), block.timestamp + 30 days, "spec:0xabc", hook);
        vm.prank(provider);
        kernel.setBudget(jobId, budget, "");
        vm.prank(client);
        kernel.fund(jobId, budget, "");
        vm.prank(provider);
        kernel.submit(jobId, keccak256("deliverable"), abi.encode(agentId, requestHash));
        vm.prank(client);
        keeper.dispute(jobId, keccak256("evidence"));
        jobIds.push(jobId);
        opened++;
    }

    function voteComplete(uint256 index, uint16 bpsSeed) external {
        uint256 jobId = _pending(index);
        if (jobId == 0) return;
        uint16 bps = uint16(bound(uint256(bpsSeed), 1, 10_000));
        vm.prank(arbiters[0]);
        arbitration.vote(jobId, IArbitration.Outcome.Complete, bps);
        vm.prank(arbiters[1]);
        arbitration.vote(jobId, IArbitration.Outcome.Complete, bps);
        decided++;
    }

    function voteReject(uint256 index) external {
        uint256 jobId = _pending(index);
        if (jobId == 0) return;
        vm.prank(arbiters[1]);
        arbitration.vote(jobId, IArbitration.Outcome.Reject, 0);
        vm.prank(arbiters[2]);
        arbitration.vote(jobId, IArbitration.Outcome.Reject, 0);
        decided++;
    }

    function lapse(uint256 index) external {
        uint256 jobId = _pending(index);
        if (jobId == 0) return;
        IArbitration.Dispute memory d = arbitration.disputeOf(jobId);
        vm.warp(d.resolveBy);
        arbitration.lapse(jobId);
        lapsed++;
    }

    function finalizeDecided(uint256 index) external {
        if (jobIds.length == 0) return;
        uint256 jobId = jobIds[index % jobIds.length];
        (IArbitration.Outcome outcome,,) = arbitration.decision(jobId);
        if (outcome != IArbitration.Outcome.Complete && outcome != IArbitration.Outcome.Lapsed) return;
        if (keeper.disputeOf(jobId).resolved) return;
        vm.prank(cranker);
        keeper.finalizeDecided(jobId, "");
        finalized++;
    }

    function settle(uint256 index) external {
        if (jobIds.length == 0) return;
        uint256 jobId = jobIds[index % jobIds.length];
        try arbitration.settleBond(jobId) {
            settledByAnyone++;
        } catch {}
    }

    function withdraw(uint256 who) external {
        address account = who % 2 == 0 ? client : provider;
        uint256 balance = arbitration.withdrawable(account);
        if (balance == 0) return;
        vm.prank(account);
        arbitration.withdraw();
    }

    function _pending(uint256 index) private view returns (uint256) {
        if (jobIds.length == 0) return 0;
        uint256 jobId = jobIds[index % jobIds.length];
        (IArbitration.Outcome outcome,,) = arbitration.decision(jobId);
        return outcome == IArbitration.Outcome.None ? jobId : 0;
    }
}

contract ArbitrationSolvencyInvariant is BaseTest {
    ArbitrationHandler internal handler;

    function setUp() public override {
        super.setUp();
        usdc.mint(client, 100_000_000 * USDC);
        handler = new ArbitrationHandler(
            kernel, keeper, arbitration, usdc, address(hook), client, provider, cranker, [arb1, arb2, arb3], AGENT_ID, REQUEST_HASH
        );
        targetContract(address(handler));
    }

    function invariant_bondsAreEitherHeldOrWithdrawable() public view {
        uint256 unsettled;
        for (uint256 i = 0; i < handler.count(); i++) {
            IArbitration.Dispute memory d = arbitration.disputeOf(handler.jobIds(i));
            if (!d.bondSettled) unsettled += d.bond;
        }
        uint256 owed = arbitration.withdrawable(client) + arbitration.withdrawable(provider);
        assertEq(usdc.balanceOf(address(arbitration)), owed + unsettled, "every unit in Arbitration is a live bond or somebody's balance");
    }

    function invariant_terminalJobsHaveSettledBonds() public view {
        for (uint256 i = 0; i < handler.count(); i++) {
            uint256 jobId = handler.jobIds(i);
            ISquareJob.JobStatus s = kernel.getJobRecord(jobId).status;
            if (s == ISquareJob.JobStatus.Completed || s == ISquareJob.JobStatus.Rejected || s == ISquareJob.JobStatus.Expired) {
                assertTrue(arbitration.disputeOf(jobId).bondSettled, "a settled job never leaves a bond behind");
            }
        }
    }

    function invariant_kernelStaysSolvent() public view {
        assertSolvent();
    }
}
