// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

interface IPayoutResolver is IERC165 {
    /// @notice Who is paid when `jobId` completes, and what share of the net.
    /// @dev `data` is `abi.encode(reason, optParams)` as `complete` received it.
    ///      An implementation may read `data` to shape its answer, but whether
    ///      it can answer at all must not depend on it: the kernel probes this
    ///      function with `abi.encode(bytes32(0), bytes(""))` before it lets an
    ///      expired submitted job be refunded, and treats a revert or a zero
    ///      payee as "the resolver cannot settle this job". A resolver that
    ///      reverts on empty `optParams` while answering the real call would
    ///      either lock the escrow or hand a settleable job to the refund.
    function resolvePayout(uint256 jobId, bytes calldata data)
        external
        view
        returns (address payee, uint16 providerBps);
    function payoutMarket() external view returns (address);
}
