// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {SquareJob} from "../src/SquareJob.sol";
import {KeeperEvaluator} from "../src/KeeperEvaluator.sol";
import {Arbitration} from "../src/Arbitration.sol";
import {ClaimMarket} from "../src/ClaimMarket.sol";
import {SquareHook} from "../src/SquareHook.sol";
import {MockUSDC3009} from "../test/mocks/MockUSDC3009.sol";
import {MockIdentityRegistry, MockReputationRegistry, MockValidationRegistry} from "../test/mocks/MockRegistries.sol";

contract DeployLocal is Script {
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
    }

    function run() external {
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
        s.keeper = new KeeperEvaluator(address(s.kernel), deployer, 1 days, 3 days);
        s.arbitration = new Arbitration(address(s.keeper), deployer, 1_000, 1_000_000);
        s.market = new ClaimMarket(address(s.kernel), address(s.keeper));
        s.hook = new SquareHook(
            address(s.kernel),
            address(s.market),
            address(m.identity),
            address(m.reputation),
            address(m.validation),
            deployer
        );
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
        vm.serializeAddress(json, "USDC", address(m.usdc));
        vm.serializeAddress(json, "IdentityRegistry", address(m.identity));
        vm.serializeAddress(json, "ReputationRegistry", address(m.reputation));
        string memory out = vm.serializeAddress(json, "ValidationRegistry", address(m.validation));
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(out, path);
        console2.log("local stack written to", path);
    }
}
