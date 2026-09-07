// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

interface ISettlementHorizon is IERC165 {
    function settlementHorizon() external view returns (uint48);
}
