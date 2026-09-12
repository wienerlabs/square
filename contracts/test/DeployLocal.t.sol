// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployLocal} from "../script/DeployLocal.s.sol";

/// Where DeployLocal is willing to write, and on which chain.
///
/// The script deploys mocks and records their addresses. For 31337 the record
/// is `deployments/31337.json`, ignored by git. For any other chain the same
/// path is the record of that chain's real deployment, and square#270 is what
/// happens when a mock stack lands there: the Arc Testnet addresses gone from
/// the working tree after `npm test` in packages/aa.
contract DeployLocalTest is Test {
    uint256 internal constant ARC_TESTNET = 5042002;
    string internal constant ARC_RECORD = "deployments/5042002.json";

    DeployLocal internal script;

    function setUp() public {
        script = new DeployLocal();
    }

    function test_on31337ThePathIsTheLocalRecordUnlessNamed() public view {
        assertEq(script.deploymentPath(31337, ""), "deployments/31337.json");
        assertEq(script.deploymentPath(31337, "deployments/elsewhere.json"), "deployments/elsewhere.json");
    }

    function test_onAnotherChainThePathHasToBeNamed() public {
        vm.expectRevert(
            abi.encodeWithSelector(DeployLocal.DeploymentFileRequired.selector, ARC_TESTNET, ARC_RECORD)
        );
        script.deploymentPath(ARC_TESTNET, "");
    }

    function test_onAnotherChainTheChainsOwnRecordIsRefused() public {
        vm.expectRevert(
            abi.encodeWithSelector(DeployLocal.DeploymentFileIsTheRecord.selector, ARC_TESTNET, ARC_RECORD)
        );
        script.deploymentPath(ARC_TESTNET, ARC_RECORD);
    }

    function test_onAnotherChainAnyOtherNameIsTakenAsGiven() public view {
        assertEq(
            script.deploymentPath(ARC_TESTNET, "deployments/5042002.local.json"),
            "deployments/5042002.local.json"
        );
    }

    /// The rules above, reached through `run()` and the environment it reads.
    ///
    /// One test, in order: `vm.setEnv` is process-wide and the functions of a
    /// test contract run in parallel, so the steps that depend on what is set
    /// cannot be separate tests. And on a chain id that has no record in this
    /// tree: `vm.writeJson` writes to disk whatever the EVM does afterwards,
    /// so a `run()` that a regressed guard lets through would land its mock
    /// addresses in `deployments/<chainid>.json`. For 5042002 that is the
    /// committed record, the very thing under test; for this id it is a stray
    /// untracked file.
    uint256 internal constant NOWHERE = 424242;
    string internal constant NOWHERE_RECORD = "deployments/424242.json";

    function test_runReadsTheEnvironmentAndRefuses() public {
        vm.chainId(NOWHERE);

        // Without DEPLOY_LOCAL_ALLOW_CHAIN_ID the chain itself is refused (square#232).
        vm.expectRevert(abi.encodeWithSelector(DeployLocal.WrongChain.selector, NOWHERE, 31337));
        script.run();

        // With it, and nothing naming the file, the path is refused.
        vm.setEnv("DEPLOY_LOCAL_ALLOW_CHAIN_ID", "424242");
        vm.expectRevert(
            abi.encodeWithSelector(DeployLocal.DeploymentFileRequired.selector, NOWHERE, NOWHERE_RECORD)
        );
        script.run();

        // Naming the chain's own record is refused too.
        vm.setEnv("DEPLOYMENT_FILE", NOWHERE_RECORD);
        vm.expectRevert(
            abi.encodeWithSelector(DeployLocal.DeploymentFileIsTheRecord.selector, NOWHERE, NOWHERE_RECORD)
        );
        script.run();
    }
}
