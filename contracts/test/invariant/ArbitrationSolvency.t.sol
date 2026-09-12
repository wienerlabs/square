// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {BaseTest} from "../Base.t.sol";
import {SquareJob} from "../../src/SquareJob.sol";
import {KeeperEvaluator} from "../../src/KeeperEvaluator.sol";
import {Arbitration} from "../../src/Arbitration.sol";
import {ISquareJob} from "../../src/interfaces/ISquareJob.sol";
import {IArbitration} from "../../src/interfaces/IArbitration.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MaliciousHook} from "../mocks/MaliciousHook.sol";

contract ArbitrationHandler is Test {
    SquareJob internal kernel;
    KeeperEvaluator internal keeper;
    Arbitration internal arbitration;
    MockUSDC internal usdc;
    address internal hook;
    address internal deadHook;
    address internal client;
    address internal provider;
    address internal cranker;
    address[3] internal arbiters;
    uint256 internal agentId;
    bytes32 internal requestHash;

    uint256[] public jobIds;
    mapping(uint256 => bool) public deadResolver;
    uint256 public opened;
    uint256 public decided;
    uint256 public lapsed;
    uint256 public finalized;
    uint256 public settledByAnyone;
    uint256 public expiredByAnyone;
    uint256 public expireCalls;
    uint256 public settleCalls;
    uint256 public kernelWithdrawals;

    constructor(
        SquareJob kernel_,
        KeeperEvaluator keeper_,
        Arbitration arbitration_,
        MockUSDC usdc_,
        address hook_,
        address deadHook_,
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
        deadHook = deadHook_;
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

    function openDisputeUnderADeadResolver(uint96 budgetSeed) external {
        uint256 budget = bound(uint256(budgetSeed), 2_000_000, 1_000_000_000);
        vm.prank(client);
        uint256 jobId = kernel.createJob(provider, address(keeper), block.timestamp + 30 days, "spec:0xdead", deadHook);
        vm.prank(provider);
        kernel.setBudget(jobId, budget, "");
        vm.prank(client);
        kernel.fund(jobId, budget, "");
        vm.prank(provider);
        kernel.submit(jobId, keccak256("deliverable"), abi.encode(agentId, requestHash));
        vm.prank(client);
        keeper.dispute(jobId, keccak256("evidence"));
        jobIds.push(jobId);
        deadResolver[jobId] = true;
        opened++;
    }

    function expire(uint256 index) external {
        expireCalls++;
        uint256 jobId = _expirable(index);
        if (jobId == 0) return;
        ISquareJob.JobRecord memory job = kernel.getJobRecord(jobId);
        if (block.timestamp < job.expiredAt) vm.warp(job.expiredAt);
        kernel.claimRefund(jobId);
        expiredByAnyone++;
    }

    function _expirable(uint256 index) private view returns (uint256) {
        uint256 length = jobIds.length;
        for (uint256 offset = 0; offset < length; offset++) {
            uint256 jobId = jobIds[(index % length + offset) % length];
            if (!deadResolver[jobId]) continue;
            ISquareJob.JobStatus s = kernel.getJobRecord(jobId).status;
            if (s == ISquareJob.JobStatus.Submitted || s == ISquareJob.JobStatus.Funded) return jobId;
        }
        return 0;
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
        if (block.timestamp < d.resolveBy) vm.warp(d.resolveBy);
        arbitration.lapse(jobId);
        lapsed++;
    }

    function finalizeDecided(uint256 index) external {
        if (jobIds.length == 0) return;
        uint256 jobId = jobIds[index % jobIds.length];
        if (deadResolver[jobId]) return;
        (IArbitration.Outcome outcome,,) = arbitration.decision(jobId);
        if (outcome != IArbitration.Outcome.Complete && outcome != IArbitration.Outcome.Lapsed) return;
        if (keeper.disputeOf(jobId).resolved) return;
        vm.prank(cranker);
        keeper.finalizeDecided(jobId, "");
        finalized++;
    }

    function settle(uint256 index) external {
        settleCalls++;
        uint256 length = jobIds.length;
        for (uint256 offset = 0; offset < length; offset++) {
            uint256 jobId = jobIds[(index % length + offset) % length];
            if (!_settleable(jobId)) continue;
            arbitration.settleBond(jobId);
            settledByAnyone++;
            return;
        }
    }

    function _settleable(uint256 jobId) private view returns (bool) {
        IArbitration.Dispute memory d = arbitration.disputeOf(jobId);
        if (d.disputedAt == 0 || d.bondSettled) return false;
        ISquareJob.JobStatus s = kernel.getJobRecord(jobId).status;
        if (s == ISquareJob.JobStatus.Expired) return true;
        return s == ISquareJob.JobStatus.Completed
            && (d.outcome == IArbitration.Outcome.Complete || d.outcome == IArbitration.Outcome.Lapsed);
    }

    function withdraw(uint256 who) external {
        address account = who % 2 == 0 ? client : provider;
        uint256 balance = arbitration.withdrawable(account);
        if (balance == 0) return;
        vm.prank(account);
        arbitration.withdraw();
    }

    function withdrawFromKernel(uint256 who) external {
        address account = who % 2 == 0 ? client : provider;
        if (kernel.withdrawable(account) == 0) return;
        vm.prank(account);
        kernel.withdraw();
        kernelWithdrawals++;
    }

    function _pending(uint256 index) private view returns (uint256) {
        if (jobIds.length == 0) return 0;
        uint256 jobId = jobIds[index % jobIds.length];
        (IArbitration.Outcome outcome,,) = arbitration.decision(jobId);
        if (outcome != IArbitration.Outcome.None) return 0;
        ISquareJob.JobStatus s = kernel.getJobRecord(jobId).status;
        if (s != ISquareJob.JobStatus.Submitted && s != ISquareJob.JobStatus.Funded) return 0;
        return jobId;
    }
}

contract ArbitrationSolvencyInvariant is BaseTest {
    ArbitrationHandler internal handler;
    MaliciousHook internal deadHook;

    function setUp() public override {
        super.setUp();
        usdc.mint(client, 100_000_000 * USDC);
        deadHook = new MaliciousHook(address(kernel));
        deadHook.setMode(MaliciousHook.Mode.ResolverReverts);
        vm.prank(owner);
        kernel.setHookWhitelist(address(deadHook), true);
        handler = new ArbitrationHandler(
            kernel,
            keeper,
            arbitration,
            usdc,
            address(hook),
            address(deadHook),
            client,
            provider,
            cranker,
            [arb1, arb2, arb3],
            AGENT_ID,
            REQUEST_HASH
        );
        handler.openDisputeUnderADeadResolver(500_000_000);
        handler.expire(0);
        targetContract(address(handler));
    }

    function afterInvariant() public view {
        uint256[6] memory states;
        for (uint256 i = 0; i < handler.count(); i++) {
            states[uint8(kernel.getJobRecord(handler.jobIds(i)).status)]++;
        }
        console2.log("disputed jobs, by state");
        console2.log("  funded              ", states[uint8(ISquareJob.JobStatus.Funded)]);
        console2.log("  submitted           ", states[uint8(ISquareJob.JobStatus.Submitted)]);
        console2.log("  completed           ", states[uint8(ISquareJob.JobStatus.Completed)]);
        console2.log("  rejected            ", states[uint8(ISquareJob.JobStatus.Rejected)]);
        console2.log("  expired             ", states[uint8(ISquareJob.JobStatus.Expired)]);
        console2.log("decisions reached     ", handler.decided());
        console2.log("disputes lapsed       ", handler.lapsed());
        console2.log("finalized by a cranker", handler.finalized());
        console2.log("expiries by anyone    ", handler.expiredByAnyone());
        console2.log("bonds settled by anyone", handler.settledByAnyone());
        console2.log("kernel withdrawals    ", handler.kernelWithdrawals());
        assertGt(
            states[uint8(ISquareJob.JobStatus.Expired)],
            0,
            "no disputed job was ever Expired, so the expiry branch of settleBond went untested"
        );
        if (handler.settleCalls() > 0) {
            assertGt(
                handler.settledByAnyone(),
                0,
                "settleBond was called with a settleable bond in reach and never once succeeded"
            );
        }
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

    function invariant_settledJobsLeaveNoBondBehind() public view {
        for (uint256 i = 0; i < handler.count(); i++) {
            uint256 jobId = handler.jobIds(i);
            ISquareJob.JobStatus s = kernel.getJobRecord(jobId).status;
            if (s == ISquareJob.JobStatus.Completed || s == ISquareJob.JobStatus.Rejected) {
                assertTrue(arbitration.disputeOf(jobId).bondSettled, "a completed or rejected job never leaves a bond behind");
            }
        }
    }

    function invariant_anExpiredJobsBondIsStillReachable() public view {
        for (uint256 i = 0; i < handler.count(); i++) {
            uint256 jobId = handler.jobIds(i);
            if (kernel.getJobRecord(jobId).status != ISquareJob.JobStatus.Expired) continue;
            IArbitration.Dispute memory d = arbitration.disputeOf(jobId);
            if (d.bondSettled) continue;
            assertGe(
                usdc.balanceOf(address(arbitration)),
                d.bond,
                "an expiry settles no bond on its own, so the money has to be there for the settleBond that follows"
            );
        }
    }

    function invariant_kernelStaysSolvent() public view {
        assertSolvent();
    }
}
