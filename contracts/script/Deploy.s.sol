// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {SquareJob} from "../src/SquareJob.sol";
import {KeeperEvaluator} from "../src/KeeperEvaluator.sol";
import {Arbitration} from "../src/Arbitration.sol";
import {ClaimMarket} from "../src/ClaimMarket.sol";
import {SquareHook} from "../src/SquareHook.sol";

contract Deploy is Script {
    struct Params {
        uint256 key;
        address deployer;
        address owner;
        address treasury;
        address usdc;
        address identity;
        address reputation;
        address validation;
        uint16 platformFeeBP;
        uint16 evaluatorFeeBP;
        uint256 hookGasLimit;
        uint48 challengeWindow;
        uint48 disputeWindow;
        uint16 bondBps;
        uint64 minBond;
        uint8 threshold;
        address[] arbiters;
    }

    struct Deployment {
        address squareJob;
        address keeperEvaluator;
        address arbitration;
        address claimMarket;
        address squareHook;
    }

    function run() external returns (Deployment memory d) {
        Params memory p = _params();
        vm.startBroadcast(p.key);
        d = _deploy(p);
        vm.stopBroadcast();
        _record(d, p);
    }

    function _params() private view returns (Params memory p) {
        p.key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        p.deployer = vm.addr(p.key);
        p.owner = vm.envOr("OWNER", p.deployer);
        p.treasury = vm.envOr("TREASURY", p.owner);
        p.usdc = vm.envAddress("USDC_ADDRESS");
        p.identity = vm.envAddress("IDENTITY_REGISTRY");
        p.reputation = vm.envAddress("REPUTATION_REGISTRY");
        p.validation = vm.envAddress("VALIDATION_REGISTRY");
        p.platformFeeBP = uint16(vm.envOr("PLATFORM_FEE_BP", uint256(0)));
        p.evaluatorFeeBP = uint16(vm.envOr("EVALUATOR_FEE_BP", uint256(50)));
        p.hookGasLimit = vm.envOr("HOOK_GAS_LIMIT", uint256(1_000_000));
        p.challengeWindow = uint48(vm.envOr("CHALLENGE_WINDOW", uint256(1 days)));
        p.disputeWindow = uint48(vm.envOr("DISPUTE_WINDOW", uint256(3 days)));
        p.bondBps = uint16(vm.envOr("BOND_BPS", uint256(1_000)));
        p.minBond = uint64(vm.envOr("MIN_BOND", uint256(1_000_000)));
        p.threshold = uint8(vm.envOr("ARBITER_THRESHOLD", uint256(2)));
        p.arbiters = vm.envOr("ARBITERS", ",", new address[](0));
    }

    function _deploy(Params memory p) private returns (Deployment memory d) {
        SquareJob kernel =
            new SquareJob(p.usdc, p.treasury, p.platformFeeBP, p.evaluatorFeeBP, p.hookGasLimit, p.deployer);
        KeeperEvaluator keeper = new KeeperEvaluator(address(kernel), p.deployer, p.challengeWindow, p.disputeWindow);
        Arbitration arbitration = new Arbitration(address(keeper), p.deployer, p.bondBps, p.minBond);
        ClaimMarket market = new ClaimMarket(address(kernel), address(keeper));
        SquareHook hook =
            new SquareHook(address(kernel), address(market), p.identity, p.reputation, p.validation, p.deployer);

        keeper.setArbitration(address(arbitration));
        kernel.setHookWhitelist(address(hook), true);
        if (p.arbiters.length > 0) arbitration.setArbiters(p.arbiters, p.threshold);
        if (p.owner != p.deployer) {
            kernel.transferOwnership(p.owner);
            keeper.transferOwnership(p.owner);
            arbitration.transferOwnership(p.owner);
            hook.transferOwnership(p.owner);
        }
        d = Deployment(address(kernel), address(keeper), address(arbitration), address(market), address(hook));
    }

    function _record(Deployment memory d, Params memory p) private {
        string memory json = "deployment";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "SquareJob", d.squareJob);
        vm.serializeAddress(json, "KeeperEvaluator", d.keeperEvaluator);
        vm.serializeAddress(json, "Arbitration", d.arbitration);
        vm.serializeAddress(json, "ClaimMarket", d.claimMarket);
        vm.serializeAddress(json, "SquareHook", d.squareHook);
        vm.serializeAddress(json, "USDC", p.usdc);
        vm.serializeAddress(json, "IdentityRegistry", p.identity);
        vm.serializeAddress(json, "ReputationRegistry", p.reputation);
        string memory out = vm.serializeAddress(json, "ValidationRegistry", p.validation);
        string memory path =
            vm.envOr("DEPLOYMENT_FILE", string.concat("deployments/", vm.toString(block.chainid), ".json"));
        vm.writeJson(out, path);
        console2.log("SquareJob        ", d.squareJob);
        console2.log("KeeperEvaluator  ", d.keeperEvaluator);
        console2.log("Arbitration      ", d.arbitration);
        console2.log("ClaimMarket      ", d.claimMarket);
        console2.log("SquareHook       ", d.squareHook);
        console2.log("written          ", path);
    }
}
