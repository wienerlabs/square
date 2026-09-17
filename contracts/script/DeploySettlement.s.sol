// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {SquareJob} from "../src/SquareJob.sol";
import {KeeperEvaluator} from "../src/KeeperEvaluator.sol";
import {Arbitration} from "../src/Arbitration.sol";
import {ClaimMarket} from "../src/ClaimMarket.sol";
import {SquareHook} from "../src/SquareHook.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";
import {ComplianceModule} from "../src/ComplianceModule.sol";
import {Groth16Verifier} from "../src/Groth16Verifier.sol";
import {ScreeningRegistry} from "../src/ScreeningRegistry.sol";

contract DeploySettlement is Script {
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
        uint48 finalizeGrace;
        uint16 bondBps;
        uint64 minBond;
        uint8 threshold;
        uint64 minReputationBudget;
        uint64 timestampTolerance;
        uint64 screeningMaxAge;
        address screenerAddress;
        bool installComplianceModule;
        bool installScreening;
        address[] arbiters;
    }

    struct Deployment {
        address squareJob;
        address keeperEvaluator;
        address arbitration;
        address claimMarket;
        address squareHook;
        address policyRegistry;
        address groth16Verifier;
        address complianceModule;
        address screeningRegistry;
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
        p.finalizeGrace = uint48(vm.envOr("FINALIZE_GRACE", uint256(1 hours)));
        p.bondBps = uint16(vm.envOr("BOND_BPS", uint256(1_000)));
        p.minBond = uint64(vm.envOr("MIN_BOND", uint256(1_000_000)));
        p.threshold = uint8(vm.envOr("ARBITER_THRESHOLD", uint256(2)));
        p.minReputationBudget = uint64(vm.envOr("MIN_REPUTATION_BUDGET", uint256(1_000_000)));
        p.timestampTolerance = uint64(vm.envOr("TIMESTAMP_TOLERANCE", uint256(1 hours)));
        p.screeningMaxAge = uint64(vm.envOr("SCREENING_MAX_AGE", uint256(1 hours)));
        p.screenerAddress = vm.envOr("SCREENER_ADDRESS", address(0));
        p.installComplianceModule = vm.envOr("INSTALL_COMPLIANCE_MODULE", false);
        p.installScreening = vm.envOr("INSTALL_SCREENING", false);
        p.arbiters = vm.envOr("ARBITERS", ",", new address[](0));
    }

    function _deploy(Params memory p) private returns (Deployment memory d) {
        SquareJob kernel =
            new SquareJob(p.usdc, p.treasury, p.platformFeeBP, p.evaluatorFeeBP, p.hookGasLimit, p.deployer);
        KeeperEvaluator keeper =
            new KeeperEvaluator(address(kernel), p.deployer, p.challengeWindow, p.disputeWindow, p.finalizeGrace);
        Arbitration arbitration = new Arbitration(address(keeper), p.deployer, p.bondBps, p.minBond);
        // square#30: a receivable sells only to a buyer on its poster's list,
        // and the list lives in the registry, so the market needs it first.
        PolicyRegistry registry = new PolicyRegistry(p.deployer);
        ClaimMarket market = new ClaimMarket(address(kernel), address(keeper), address(registry));
        SquareHook hook = new SquareHook(
            address(kernel),
            address(market),
            p.identity,
            p.reputation,
            p.validation,
            p.deployer,
            address(keeper),
            p.minReputationBudget
        );

        Groth16Verifier verifier = new Groth16Verifier();
        ComplianceModule compliance =
            new ComplianceModule(address(verifier), address(registry), address(kernel), p.deployer, p.timestampTolerance);
        compliance.setHook(address(hook));
        registry.setSpender(address(compliance), true);

        ScreeningRegistry screening = new ScreeningRegistry(p.deployer, p.screeningMaxAge);
        if (p.screenerAddress != address(0)) {
            screening.setScreener(p.screenerAddress, true);
            console2.log("screener registered on the screening registry:", p.screenerAddress);
        } else {
            console2.log("no SCREENER_ADDRESS: the registry recognises no screener, so it clears nobody");
        }

        keeper.setArbitration(address(arbitration));
        kernel.setHookWhitelist(address(hook), true);
        if (p.arbiters.length > 0) arbitration.setArbiters(p.arbiters, p.threshold);
        if (p.installComplianceModule) {
            hook.setComplianceModule(address(compliance));
            console2.log("compliance module installed on the hook: every release now needs a proof bound to the job");
        } else {
            console2.log("compliance module deployed and registered as a spender, not installed on the hook");
            console2.log("INSTALL_COMPLIANCE_MODULE=true installs it");
        }
        if (p.installScreening) {
            hook.setScreening(address(screening));
            console2.log("screening installed on the hook: funding and release now need a fresh screening");
        } else {
            console2.log("screening registry deployed, not installed on the hook");
            console2.log("INSTALL_SCREENING=true installs it");
        }
        if (p.owner != p.deployer) {
            kernel.transferOwnership(p.owner);
            keeper.transferOwnership(p.owner);
            arbitration.transferOwnership(p.owner);
            hook.transferOwnership(p.owner);
            registry.transferOwnership(p.owner);
            compliance.transferOwnership(p.owner);
            screening.transferOwnership(p.owner);
            console2.log("ownership offered to", p.owner);
            console2.log("it passes only when that account calls acceptOwnership() on each of");
            console2.log("SquareJob, KeeperEvaluator, Arbitration, SquareHook, PolicyRegistry, ComplianceModule");
            console2.log("and ScreeningRegistry; until then the deployer owns them");
        }
        d = Deployment(
            address(kernel),
            address(keeper),
            address(arbitration),
            address(market),
            address(hook),
            address(registry),
            address(verifier),
            address(compliance),
            address(screening)
        );
    }

    function _record(Deployment memory d, Params memory p) private {
        string memory json = "deployment";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeUint(json, "block", block.number);
        vm.serializeString(json, "commit", vm.envOr("GIT_COMMIT", string("unknown")));
        vm.serializeString(json, "compiler", "0.8.28+cancun");
        vm.serializeAddress(json, "SquareJob", d.squareJob);
        vm.serializeAddress(json, "KeeperEvaluator", d.keeperEvaluator);
        vm.serializeAddress(json, "Arbitration", d.arbitration);
        vm.serializeAddress(json, "ClaimMarket", d.claimMarket);
        vm.serializeAddress(json, "SquareHook", d.squareHook);
        vm.serializeAddress(json, "PolicyRegistry", d.policyRegistry);
        vm.serializeAddress(json, "Groth16Verifier", d.groth16Verifier);
        vm.serializeAddress(json, "ComplianceModule", d.complianceModule);
        vm.serializeAddress(json, "ScreeningRegistry", d.screeningRegistry);
        vm.serializeAddress(json, "USDC", p.usdc);
        vm.serializeAddress(json, "IdentityRegistry", p.identity);
        vm.serializeAddress(json, "ReputationRegistry", p.reputation);
        string memory out = vm.serializeAddress(json, "ValidationRegistry", p.validation);
        string memory chain = vm.toString(block.chainid);
        bytes32 broadcast = keccak256(bytes(vm.envOr("BROADCAST", string("1"))));
        string memory rehearsal = broadcast == keccak256(bytes("1")) ? "" : ".dry-run";
        string memory path =
            vm.envOr("DEPLOYMENT_FILE", string.concat("deployments/", chain, rehearsal, ".json"));
        vm.writeJson(out, path);
        console2.log("SquareJob        ", d.squareJob);
        console2.log("KeeperEvaluator  ", d.keeperEvaluator);
        console2.log("Arbitration      ", d.arbitration);
        console2.log("ClaimMarket      ", d.claimMarket);
        console2.log("SquareHook       ", d.squareHook);
        console2.log("PolicyRegistry   ", d.policyRegistry);
        console2.log("block            ", block.number);
        console2.log("written          ", path);
    }
}
