// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IACPHook} from "../../src/interfaces/IACPHook.sol";
import {ISquareJob} from "../../src/interfaces/ISquareJob.sol";

contract KernelBatcher {
    address private immutable _logic;

    constructor(address logic) {
        _logic = logic;
    }

    function completeHooksOf(IACPHook hook, uint256 checkedJob, uint256 settledJob, bytes calldata data) external {
        hook.beforeAction(checkedJob, ISquareJob.complete.selector, data);
        hook.afterAction(settledJob, ISquareJob.complete.selector, data);
    }

    fallback() external payable {
        address logic = _logic;
        assembly ("memory-safe") {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), logic, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    receive() external payable {}
}
