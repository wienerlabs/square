// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IClaimMarket} from "../src/interfaces/IClaimMarket.sol";
import {IPolicyRegistry} from "../src/interfaces/IPolicyRegistry.sol";

/// A buyer list the way a poster builds one off chain: salted leaves, pairs
/// hashed in sorted order, an odd node carried up unpaired. square#30.
///
/// Written independently of `MerkleProof` on purpose. The market verifies with
/// OpenZeppelin's library; if this builder and that verifier disagreed about the
/// tree, every eligible buyer in the suite would be refused.
library BuyerTree {
    function leaf(address buyer, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(buyer, salt))));
    }

    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        require(leaves.length > 0, "an empty list has no root");
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            level = _up(level);
        }
        return level[0];
    }

    function proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory path) {
        require(index < leaves.length, "no such leaf");
        bytes32[] memory scratch = new bytes32[](256);
        uint256 depth;
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            uint256 sibling = index ^ 1;
            if (sibling < level.length) scratch[depth++] = level[sibling];
            level = _up(level);
            index /= 2;
        }
        path = new bytes32[](depth);
        for (uint256 i = 0; i < depth; i++) {
            path[i] = scratch[i];
        }
    }

    function _up(bytes32[] memory level) private pure returns (bytes32[] memory next) {
        next = new bytes32[]((level.length + 1) / 2);
        for (uint256 i = 0; i < level.length; i += 2) {
            next[i / 2] = i + 1 < level.length ? _pair(level[i], level[i + 1]) : level[i];
        }
    }

    function _pair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }
}

/// Posters' buyer lists, held the way a poster holds one: the salts stay here,
/// only the root goes to the registry. Each salt is drawn for the run, so no
/// test can pass by knowing one in advance.
abstract contract BuyerLists is Test {
    mapping(address poster => address[]) private _buyersOf;
    mapping(address poster => mapping(address buyer => bytes32)) internal saltOf;

    function approveBuyers(IPolicyRegistry registry_, address poster, address[] memory buyers)
        internal
        returns (bytes32 root)
    {
        delete _buyersOf[poster];
        for (uint256 i = 0; i < buyers.length; i++) {
            if (saltOf[poster][buyers[i]] == bytes32(0)) saltOf[poster][buyers[i]] = bytes32(vm.randomUint());
            _buyersOf[poster].push(buyers[i]);
        }
        root = BuyerTree.root(_leaves(poster));
        vm.prank(poster);
        registry_.setBuyerRoot(root);
    }

    /// What `who` hands to `buy`: its salt and its path to `poster`'s root.
    function eligibility(address poster, address who) internal view returns (bytes32 salt, bytes32[] memory path) {
        address[] storage buyers = _buyersOf[poster];
        for (uint256 i = 0; i < buyers.length; i++) {
            if (buyers[i] == who) return (saltOf[poster][who], BuyerTree.proof(_leaves(poster), i));
        }
        revert("not on the poster's list");
    }

    function buyFrom(IClaimMarket claimMarket, address poster, address who, uint256 jobId, uint64 price) internal {
        (bytes32 salt, bytes32[] memory path) = eligibility(poster, who);
        vm.prank(who);
        claimMarket.buy(jobId, price, salt, path);
    }

    function _leaves(address poster) private view returns (bytes32[] memory leaves) {
        address[] storage buyers = _buyersOf[poster];
        leaves = new bytes32[](buyers.length);
        for (uint256 i = 0; i < buyers.length; i++) {
            leaves[i] = BuyerTree.leaf(buyers[i], saltOf[poster][buyers[i]]);
        }
    }
}
