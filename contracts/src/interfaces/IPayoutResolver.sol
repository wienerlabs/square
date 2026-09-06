// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

interface IPayoutResolver is IERC165 {
    function resolvePayout(uint256 jobId, bytes calldata data)
        external
        view
        returns (address payee, uint16 providerBps);
}
