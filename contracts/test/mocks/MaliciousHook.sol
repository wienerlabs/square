// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IACPHook} from "../../src/interfaces/IACPHook.sol";
import {IPayoutResolver} from "../../src/interfaces/IPayoutResolver.sol";
import {ISquareJob} from "../../src/interfaces/ISquareJob.sol";

contract MaliciousHook is IACPHook, IPayoutResolver, ERC165 {
    enum Mode {
        Quiet,
        ReenterComplete,
        ReenterWithdraw,
        ReenterClaimRefund,
        Revert,
        Loop,
        BadPayee,
        BadSplit,
        StealPayout
    }

    ISquareJob public immutable kernel;
    Mode public mode;
    address public thief;
    uint256 public calls;
    bytes public lastReentryError;

    error HookSaysNo();

    constructor(address kernel_) {
        kernel = ISquareJob(kernel_);
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function setThief(address t) external {
        thief = t;
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC165, IERC165) returns (bool) {
        return interfaceId == type(IACPHook).interfaceId || interfaceId == type(IPayoutResolver).interfaceId
            || super.supportsInterface(interfaceId);
    }

    function payoutMarket() external pure returns (address) {

        return address(0);

    }


    function resolvePayout(uint256 jobId, bytes calldata) external view returns (address, uint16) {
        if (mode == Mode.BadPayee) return (address(0), 10_000);
        if (mode == Mode.BadSplit) return (kernel.getJobRecord(jobId).provider, 10_001);
        if (mode == Mode.StealPayout) return (thief, 10_000);
        return (kernel.getJobRecord(jobId).provider, 10_000);
    }

    function beforeAction(uint256 jobId, bytes4, bytes calldata) external {
        calls++;
        _misbehave(jobId);
    }

    function afterAction(uint256 jobId, bytes4, bytes calldata) external {
        calls++;
        _misbehave(jobId);
    }

    function _misbehave(uint256 jobId) private {
        if (mode == Mode.Revert) revert HookSaysNo();
        if (mode == Mode.Loop) {
            uint256 x;
            while (true) x = uint256(keccak256(abi.encode(x)));
        }
        if (mode == Mode.ReenterComplete) {
            try kernel.complete(jobId, bytes32(0), "") {} catch (bytes memory err) { lastReentryError = err; }
        }
        if (mode == Mode.ReenterWithdraw) {
            try kernel.withdraw() {} catch (bytes memory err) { lastReentryError = err; }
        }
        if (mode == Mode.ReenterClaimRefund) {
            try kernel.claimRefund(jobId) {} catch (bytes memory err) { lastReentryError = err; }
        }
    }
}
