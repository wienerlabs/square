// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {SquareJob} from "../src/SquareJob.sol";
import {KeeperEvaluator} from "../src/KeeperEvaluator.sol";
import {Arbitration} from "../src/Arbitration.sol";
import {ClaimMarket} from "../src/ClaimMarket.sol";
import {SquareHook} from "../src/SquareHook.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";
import {Groth16Verifier} from "../src/Groth16Verifier.sol";
import {ComplianceModule} from "../src/ComplianceModule.sol";
import {MockUSDC3009} from "../test/mocks/MockUSDC3009.sol";
import {MockIdentityRegistry, MockReputationRegistry, MockValidationRegistry} from "../test/mocks/MockRegistries.sol";

contract DeployLocal is Script {
    /// @dev The chain this script may deploy to, and the environment variable
    ///      that names a different one on purpose.
    ///
    ///      It deploys mocks — `MockUSDC3009`, three mock ERC-8004 registries,
    ///      a whole second kernel and hook — and then writes their addresses to
    ///      `deployments/<chainid>.json`. For 5042002 that is the file in
    ///      version control carrying the real Arc Testnet addresses.
    ///
    ///      square#232: `docs/deploy/local-stack.md` told an operator to point
    ///      the stack at Arc with `CHAIN_ID=5042002`, a funded key and a
    ///      `docker compose up` that starts this container. The mock stack would
    ///      have been broadcast to the real testnet and the deployment record
    ///      overwritten with mock addresses, with the indexer and keeper then
    ///      reporting healthy against it.
    ///
    ///      A fork answers with the chain id of the chain it forks, so no check
    ///      here can tell one from the other. `DEPLOY_LOCAL_ALLOW_CHAIN_ID` is
    ///      how a caller says which chain it means: `packages/aa` sets it to
    ///      5042002 for the Arc fork it spawns itself and deletes the artefacts
    ///      afterwards. Nothing reaches a real network without someone writing
    ///      that id down first.
    uint256 internal constant LOCAL_CHAIN_ID = 31337;

    error WrongChain(uint256 chainId, uint256 allowed);

    string internal constant ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
    address internal constant ANVIL_1 = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address internal constant ANVIL_2 = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    address internal constant ANVIL_3 = 0x90F79bf6EB2c4f870365E785982E1f101E93b906;
    address internal constant ANVIL_4 = 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65;
    address internal constant ANVIL_5 = 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc;
    address internal constant ANVIL_6 = 0x976EA74026E726554dB657fA54763abd0C3a0aa9;

    struct Mocks {
        MockUSDC3009 usdc;
        MockIdentityRegistry identity;
        MockReputationRegistry reputation;
        MockValidationRegistry validation;
    }

    struct Stack {
        SquareJob kernel;
        KeeperEvaluator keeper;
        Arbitration arbitration;
        ClaimMarket market;
        SquareHook hook;
        PolicyRegistry policy;
        Groth16Verifier verifier;
        ComplianceModule compliance;
    }

    function run() external {
        uint256 allowed = vm.envOr("DEPLOY_LOCAL_ALLOW_CHAIN_ID", LOCAL_CHAIN_ID);
        if (block.chainid != allowed) revert WrongChain(block.chainid, allowed);

        uint256 key = vm.envOr("DEPLOYER_PRIVATE_KEY", vm.deriveKey(ANVIL_MNEMONIC, 0));
        address deployer = vm.addr(key);
        vm.startBroadcast(key);
        Mocks memory mocks = _deployMocks();
        Stack memory stack = _deployStack(deployer, mocks);
        _seed(mocks);
        vm.stopBroadcast();
        _record(mocks, stack);
    }

    function _deployMocks() private returns (Mocks memory m) {
        m.usdc = new MockUSDC3009();
        m.identity = new MockIdentityRegistry();
        m.reputation = new MockReputationRegistry();
        m.validation = new MockValidationRegistry();
    }

    function _deployStack(address deployer, Mocks memory m) private returns (Stack memory s) {
        s.kernel = new SquareJob(address(m.usdc), deployer, 100, 50, 1_000_000, deployer);
        s.keeper = new KeeperEvaluator(address(s.kernel), deployer, 1 days, 3 days, 1 hours);
        s.arbitration = new Arbitration(address(s.keeper), deployer, 1_000, 1_000_000);
        // square#30: the market reads each poster's buyer list from the registry,
        // so the registry exists before the market does.
        s.policy = new PolicyRegistry(deployer);
        s.market = new ClaimMarket(address(s.kernel), address(s.keeper), address(s.policy));
        s.hook = new SquareHook(
            address(s.kernel),
            address(s.market),
            address(m.identity),
            address(m.reputation),
            address(m.validation),
            deployer,
            address(s.keeper),
            1_000_000
        );
        // square#27 filled the slot. The verifying key and the module are
        // deployed here and wired to the registry above, in the order their
        // access control needs:
        // the module has to know its hook before the hook can use it, and the
        // registry has to know the module before the module can move a counter.
        //
        // A local chain mines a block per transaction, so the tolerance is
        // generous. On a real chain it is the time between building a proof and
        // it being mined, and every second of it is a second in which a policy's
        // time window can be straddled.
        s.verifier = new Groth16Verifier();
        s.compliance = new ComplianceModule(
            address(s.verifier), address(s.policy), address(s.kernel), deployer, 1 hours
        );
        s.compliance.setHook(address(s.hook));
        s.policy.setSpender(address(s.compliance), true);

        // Installed only when asked for. Once the hook holds a module, every
        // completion needs a proof that binds to the job, and a release without
        // one pays the client instead of the provider -- which is the point of
        // square#27 and is also not what the local stack is for. Nothing on a
        // dev chain produces those proofs: the SDK lifecycle, the indexer and
        // keeper suites and the compose stack all complete jobs with an empty
        // optParams, and installing this by default would silently route their
        // money to the client.
        //
        //   INSTALL_COMPLIANCE_MODULE=true forge script script/DeployLocal.s.sol ...
        //
        // The gate's own behaviour is covered by test/ComplianceModule.t.sol
        // against real proofs, so this flag is about what a dev chain defaults
        // to, not about whether the gate works.
        if (vm.envOr("INSTALL_COMPLIANCE_MODULE", false)) {
            s.hook.setComplianceModule(address(s.compliance));
        }
        s.keeper.setArbitration(address(s.arbitration));
        s.kernel.setHookWhitelist(address(s.hook), true);
        address[] memory arbiters = new address[](3);
        arbiters[0] = ANVIL_4;
        arbiters[1] = ANVIL_5;
        arbiters[2] = ANVIL_6;
        s.arbitration.setArbiters(arbiters, 2);
    }

    function _seed(Mocks memory m) private {
        m.usdc.mint(ANVIL_1, 1_000_000e6);
        m.usdc.mint(ANVIL_3, 1_000_000e6);
        m.usdc.mint(ANVIL_2, 1_000e6);
        m.identity.setAgent(1, ANVIL_2, ANVIL_2);
    }

    function _record(Mocks memory m, Stack memory s) private {
        string memory json = "deployment";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "SquareJob", address(s.kernel));
        vm.serializeAddress(json, "KeeperEvaluator", address(s.keeper));
        vm.serializeAddress(json, "Arbitration", address(s.arbitration));
        vm.serializeAddress(json, "ClaimMarket", address(s.market));
        vm.serializeAddress(json, "SquareHook", address(s.hook));
        vm.serializeAddress(json, "PolicyRegistry", address(s.policy));
        vm.serializeAddress(json, "Groth16Verifier", address(s.verifier));
        vm.serializeAddress(json, "ComplianceModule", address(s.compliance));
        vm.serializeAddress(json, "USDC", address(m.usdc));
        vm.serializeAddress(json, "IdentityRegistry", address(m.identity));
        vm.serializeAddress(json, "ReputationRegistry", address(m.reputation));
        string memory out = vm.serializeAddress(json, "ValidationRegistry", address(m.validation));
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(out, path);
        console2.log("local stack written to", path);
    }
}
