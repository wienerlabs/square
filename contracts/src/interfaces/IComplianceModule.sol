// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title The compliance verdict on a release
/// @notice Two entry points over one decision, because the kernel asks for the
///         verdict in a `view` call and the bookkeeping needs to write.
///
/// `SquareJob.complete` calls the hook's `resolvePayout` first, strictly, and
/// takes the payout split from its answer; only then does it call the hook's
/// `beforeAction`, tolerantly. So the verdict has to reach the split through a
/// `view` — `previewRelease` — while the counter advance and the replay mark,
/// which are writes, happen in `checkRelease`.
///
/// Both run the same checks over the same state inside one transaction, so they
/// agree. The module is written so that `previewRelease` returning true implies
/// `checkRelease` can complete: everything `PolicyRegistry.recordSpend` would
/// revert on is checked by the preview first. See docs/decisions/hook-failure-modes.md
/// for why a verdict is a split and never a revert.
interface IComplianceModule {
    /// @notice Would this release be compliant? No state is touched.
    /// @dev Read by `SquareHook.resolvePayout`, which returns `providerBps = 0`
    ///      when the answer is false: the whole net goes back to the client and
    ///      the provider is paid nothing. Never reverts — an unusable proof is
    ///      `false`, not an error, because a revert here would bubble through
    ///      `_resolvePayout` and lock the escrow.
    function previewRelease(
        uint256 jobId,
        address payee,
        uint256 amount,
        address token,
        address client,
        bytes calldata proof
    ) external view returns (bool verified);

    /// @notice The same decision, with the bookkeeping.
    /// @dev Advances the poster's daily counter by `amount` and marks the proof
    ///      consumed. Returns the verdict for the ERC-8004 validation record the
    ///      hook writes in `afterAction`.
    function checkRelease(
        uint256 jobId,
        address payee,
        uint256 amount,
        address token,
        address client,
        bytes calldata proof
    ) external returns (bool verified);
}
