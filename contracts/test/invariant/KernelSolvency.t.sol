// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {BaseTest} from "../Base.t.sol";
import {SquareJob} from "../../src/SquareJob.sol";
import {ISquareJob} from "../../src/interfaces/ISquareJob.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

contract KernelHandler is Test {
    SquareJob internal kernel;
    MockUSDC internal usdc;
    address internal hook;
    address internal client;
    address internal provider;
    address internal evaluator;
    address internal treasury;
    uint256 internal agentId;
    bytes32 internal requestHash;

    uint256[] public jobIds;
    uint256 public created;
    uint256 public funded;
    uint256 public submitted;
    uint256 public completed;
    uint256 public rejected;
    uint256 public refunded;
    uint256 public withdrawals;

    constructor(
        SquareJob kernel_,
        MockUSDC usdc_,
        address hook_,
        address client_,
        address provider_,
        address evaluator_,
        address treasury_,
        uint256 agentId_,
        bytes32 requestHash_
    ) {
        kernel = kernel_;
        usdc = usdc_;
        hook = hook_;
        client = client_;
        provider = provider_;
        evaluator = evaluator_;
        treasury = treasury_;
        agentId = agentId_;
        requestHash = requestHash_;
    }

    function count() external view returns (uint256) {
        return jobIds.length;
    }

    function create(uint96 budgetSeed, bool hooked) public {
        uint256 budget = bound(uint256(budgetSeed), 2_000_000, 1_000_000_000);
        vm.prank(client);
        uint256 jobId =
            kernel.createJob(provider, evaluator, block.timestamp + 30 days, "spec:0xabc", hooked ? hook : address(0));
        vm.prank(provider);
        kernel.setBudget(jobId, budget, "");
        jobIds.push(jobId);
        created++;
    }

    function fund(uint256 index) public {
        uint256 jobId = _liveInState(index, ISquareJob.JobStatus.Open);
        if (jobId == 0) return;
        uint256 budget = kernel.getJobRecord(jobId).budget;
        vm.prank(client);
        kernel.fund(jobId, budget, "");
        funded++;
    }

    function submit(uint256 index) public {
        uint256 jobId = _liveInState(index, ISquareJob.JobStatus.Funded);
        if (jobId == 0) return;
        vm.prank(provider);
        kernel.submit(jobId, keccak256("deliverable"), abi.encode(agentId, requestHash));
        submitted++;
    }

    function completeJob(uint256 index, uint16 bpsSeed) public {
        uint256 jobId = _inState(index, ISquareJob.JobStatus.Submitted);
        if (jobId == 0) return;
        uint16 bps = kernel.getJobRecord(jobId).hookResolvesPayout ? uint16(bound(uint256(bpsSeed), 0, 10_000)) : 10_000;
        vm.prank(evaluator);
        kernel.complete(jobId, keccak256("accepted"), abi.encode(bps, bytes("")));
        completed++;
    }

    function rejectJob(uint256 index) public {
        uint256 jobId = _inState(index, ISquareJob.JobStatus.Submitted);
        if (jobId == 0) return;
        vm.prank(evaluator);
        kernel.reject(jobId, keccak256("rejected"), abi.encode(uint16(0), bytes("")));
        rejected++;
    }

    function refund(uint256 index) public {
        uint256 jobId = _inState(index, ISquareJob.JobStatus.Funded);
        if (jobId == 0) return;
        ISquareJob.JobRecord memory job = kernel.getJobRecord(jobId);
        if (block.timestamp < job.expiredAt) vm.warp(job.expiredAt);
        kernel.claimRefund(jobId);
        refunded++;
    }

    function withdrawAny(uint256 who) public {
        address[4] memory accounts = [client, provider, evaluator, treasury];
        address account = accounts[who % 4];
        if (kernel.withdrawable(account) == 0) return;
        vm.prank(account);
        kernel.withdraw();
        withdrawals++;
    }

    function _liveInState(uint256 index, ISquareJob.JobStatus wanted) private view returns (uint256) {
        uint256 length = jobIds.length;
        for (uint256 offset = 0; offset < length; offset++) {
            uint256 jobId = jobIds[(index % length + offset) % length];
            ISquareJob.JobRecord memory job = kernel.getJobRecord(jobId);
            if (job.status == wanted && block.timestamp < job.expiredAt) return jobId;
        }
        return 0;
    }

    function _inState(uint256 index, ISquareJob.JobStatus wanted) private view returns (uint256) {
        uint256 length = jobIds.length;
        for (uint256 offset = 0; offset < length; offset++) {
            uint256 jobId = jobIds[(index % length + offset) % length];
            if (kernel.getJobRecord(jobId).status == wanted) return jobId;
        }
        return 0;
    }
}

contract KernelSolvencyInvariant is BaseTest {
    KernelHandler internal handler;
    address internal eoaEvaluator = makeAddr("eoaEvaluator");

    function setUp() public override {
        super.setUp();
        usdc.mint(client, 100_000_000 * USDC);
        handler = new KernelHandler(
            kernel, usdc, address(hook), client, provider, eoaEvaluator, treasury, AGENT_ID, REQUEST_HASH
        );
        _seedEveryTerminalState();
        targetContract(address(handler));
    }

    function _seedEveryTerminalState() private {
        handler.create(500_000_000, true);
        handler.fund(0);
        handler.submit(0);
        handler.completeJob(0, 10_000);

        handler.create(400_000_000, true);
        handler.fund(0);
        handler.submit(0);
        handler.rejectJob(0);

        handler.create(300_000_000, false);
        handler.fund(0);
        handler.refund(0);
    }

    function invariant_kernelHoldsEscrowPlusLedger() public view {
        assertSolvent();
    }

    function invariant_theLedgerSumsToItsTotal() public view {
        uint256 sum = kernel.withdrawable(client) + kernel.withdrawable(provider) + kernel.withdrawable(eoaEvaluator)
            + kernel.withdrawable(treasury);
        assertEq(sum, kernel.totalWithdrawable(), "every credited unit belongs to one of the four parties");
    }

    function invariant_aClosedJobHoldsNoEscrow() public view {
        for (uint256 i = 0; i < handler.count(); i++) {
            ISquareJob.JobRecord memory job = kernel.getJobRecord(handler.jobIds(i));
            if (job.status == ISquareJob.JobStatus.Open) assertEq(job.payee, address(0));
        }
    }

    function afterInvariant() public view {
        uint256[6] memory states;
        for (uint256 i = 0; i < handler.count(); i++) {
            states[uint8(kernel.getJobRecord(handler.jobIds(i)).status)]++;
        }
        console2.log("jobs, by state");
        console2.log("  open                ", states[uint8(ISquareJob.JobStatus.Open)]);
        console2.log("  funded              ", states[uint8(ISquareJob.JobStatus.Funded)]);
        console2.log("  submitted           ", states[uint8(ISquareJob.JobStatus.Submitted)]);
        console2.log("  completed           ", states[uint8(ISquareJob.JobStatus.Completed)]);
        console2.log("  rejected            ", states[uint8(ISquareJob.JobStatus.Rejected)]);
        console2.log("  expired             ", states[uint8(ISquareJob.JobStatus.Expired)]);
        console2.log("withdrawals           ", handler.withdrawals());
        assertGt(states[uint8(ISquareJob.JobStatus.Completed)], 0, "no job was ever completed");
        assertGt(states[uint8(ISquareJob.JobStatus.Rejected)], 0, "no job was ever rejected");
        assertGt(states[uint8(ISquareJob.JobStatus.Expired)], 0, "no job ever ran out of time");
    }
}
