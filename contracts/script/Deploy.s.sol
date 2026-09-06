// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Groth16Verifier} from "../src/Groth16Verifier.sol";

/// @notice Deploy the Groth16 verifier.
///
/// The verifier is generated from a proving key and is only valid for that key.
/// Deploying it says nothing about whether the key behind it is trustworthy —
/// today it is a development key with a real phase 1 and a single-contribution
/// phase 2, so the address this produces is a testnet address that the ceremony
/// in #16 will replace. That is worth writing next to the address rather than
/// discovering later.
///
///   forge script script/Deploy.s.sol \
///     --rpc-url "$ARC_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast
///
/// Arc pays gas in USDC, so the deployer needs a funded testnet account. The
/// deployment costs roughly 486k gas by local measurement.
contract Deploy is Script {
    function run() external returns (Groth16Verifier verifier) {
        vm.startBroadcast();
        verifier = new Groth16Verifier();
        vm.stopBroadcast();

        console.log("Groth16Verifier:", address(verifier));
        console.log("chain id:       ", block.chainid);
        console.log("");
        console.log("Record the address in the README, and check it against a real proof:");
        console.log("  node script/verify-on-arc.mjs --address", address(verifier));
    }
}
