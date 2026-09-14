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
/// Both run the same checks over the same state inside one transaction, and the
/// module is written so that `previewRelease` returning true implies
/// `checkRelease` completes. The money moves on the first answer and the
/// bookkeeping happens in the second, inside a call the kernel tolerates, so
/// this has to hold for every way the second call can fail and not only for the
/// proof (#225):
///
/// - `OnlyHook`: the preview requires the job's own hook, which is the caller of
///   `checkRelease`, to be the hook the module authorises.
/// - `NotASpender` from `PolicyRegistry.recordSpend`: the preview requires the
///   module to be a registered spender.
/// - `SpendOverflow` from the same call: the preview's ceiling check keeps the
///   day's total at or below `dailyLimit`, a `uint128`, which is where the
///   overflow starts.
/// - Gas: both calls run under the kernel's `hookGasLimit`, and the check costs
///   more than the preview. The module refuses, at construction, a kernel whose
///   limit is below what the check needs.
///
/// Should `recordSpend` fail regardless, the replay mark is written before it
/// and is not rolled back with it: the proof is spent whether or not the
/// counter moved, and the hook reports the release as unconfirmed. See
/// docs/decisions/hook-failure-modes.md for why a verdict is a split and never
/// a revert.
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
    ///      hook writes in `afterAction`. Should the counter refuse the advance,
    ///      returns false with the proof still marked.
    function checkRelease(
        uint256 jobId,
        address payee,
        uint256 amount,
        address token,
        address client,
        bytes calldata proof
    ) external returns (bool verified);
}
