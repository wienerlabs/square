// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IComplianceModule} from "./interfaces/IComplianceModule.sol";
import {IGroth16Verifier} from "./interfaces/IGroth16Verifier.sol";
import {IPolicyRegistry} from "./interfaces/IPolicyRegistry.sol";
import {ISquareJob} from "./interfaces/ISquareJob.sol";

/// @title ComplianceModule
/// @notice The proof gate on the way out of escrow: a Groth16 proof, bound to
///         this job's own storage, decides whether the provider is paid.
///
/// ## The verdict is a split, never a revert
///
/// [#100](../../docs/decisions/hook-failure-modes.md) settled this and named
/// this contract: after #90 closed the refund on a `Submitted` job under a
/// horizon evaluator, a hook that reverted left the escrow with no exit at all.
/// So the kernel stopped letting a hook veto. The one channel it still honours
/// is `resolvePayout`, and a `providerBps` of zero returns the whole net to the
/// client.
///
/// That is what "the proof locks the release" means here. A missing proof, an
/// invalid proof, a proof for another job: the provider is paid nothing and the
/// client is made whole. Nobody's money is stranded, and `complete` still
/// finishes, so the state machine never stalls.
///
/// Neither entry point reverts on a bad proof. `previewRelease` is reached
/// through `SquareJob._resolvePayout`, which is strict and would bubble the
/// revert into exactly the lock #100 removed.
///
/// ## Why the proof has to be bound to the job
///
/// The verifier is stateless: it says a proof is valid for eight public
/// signals, not that those signals describe *this* payment. An unbound proof is
/// a bearer token — one compliant payment, replayed against every other job.
///
/// Aperture cross-checked the public inputs against the real transfer in the
/// accounts passed to the instruction. The EVM counterpart is to check them
/// against the job's own storage, which is what `_verify` does, signal by
/// signal:
///
/// | # | Signal | Bound to |
/// |---|---|---|
/// | 0 | `is_compliant` | must be 1 |
/// | 1 | `policy_data_hash` | `PolicyRegistry.commitmentOf(client)` |
/// | 2 | `recipient` | the address the kernel will actually pay |
/// | 3 | `amount` | the job's net payout after fees and the split |
/// | 4 | `token` | `SquareJob.paymentToken()` |
/// | 5 | `daily_spent_before` | `PolicyRegistry.spentToday(client)` |
/// | 6 | `current_unix_timestamp` | `block.timestamp` ± `timestampTolerance` |
/// | 7 | `stripe_receipt_hash` | must be 0 |
///
/// All eight, deliberately. An unbound signal is one the prover chooses, and
/// the earlier sketch of this module left `token` and `stripe_receipt_hash`
/// free. `test_everyPublicSignalIsBound` fails if a ninth appears without a
/// binding.
///
/// Signal 2 is the *payee*, not the provider. A receivable sold through
/// `ClaimMarket` pays its buyer (#29), and the hook resolves that address before
/// this module sees it. Binding to the provider would refuse every proof on a
/// sold claim, or bind to an address that is not the one being paid.
///
/// Signal 6 is why the circuit's rule 6 can be enforced at all. `payment.circom`
/// takes the timestamp as a private witness the prover picks; without this
/// window a prover chooses a time inside the policy's hours and the rule means
/// nothing. It replaces the check the circuit cannot make about itself.
///
/// ## Replay
///
/// Two mechanisms, and the first is the one that does the work.
///
/// **The daily counter.** `daily_spent_before` has to equal the poster's total
/// for today, and `checkRelease` advances that total by `amount` in the same
/// call. A proof presented twice carries a stale signal 5 the second time. This
/// is aperture's `DailySpentMismatch`, and it also makes signal 5 mean
/// something in the first place: without a counter on chain, a prover claims
/// zero every time and the circuit's daily ceiling is vacuous.
///
/// **An explicit mark.** `_consumed[keccak(proof)]`, because the counter's
/// protection is only as good as the counter: a job whose `amount` is zero
/// moves it not at all. Belt and braces, and cheap.
///
/// A job cannot be completed twice — `complete` requires `Submitted` — so this
/// is about a proof crossing from one job to another, which the bindings above
/// already make hard and these two make impossible.
contract ComplianceModule is IComplianceModule, Ownable2Step {
    uint16 private constant FULL_BPS = 10_000;

    /// @dev Index into the eight public signals. Named rather than numeric so a
    ///      reordering of the circuit's outputs shows up as a diff here.
    uint256 private constant IS_COMPLIANT = 0;
    uint256 private constant POLICY_DATA_HASH = 1;
    uint256 private constant RECIPIENT = 2;
    uint256 private constant AMOUNT = 3;
    uint256 private constant TOKEN = 4;
    uint256 private constant DAILY_SPENT_BEFORE = 5;
    uint256 private constant CURRENT_UNIX_TIMESTAMP = 6;
    uint256 private constant STRIPE_RECEIPT_HASH = 7;
    uint256 private constant SIGNAL_COUNT = 8;
    /// @dev Every component of a Groth16 proof is a fixed-size type, so the
    ///      encoding has one length: (2 + 4 + 2 + 8) words.
    uint256 private constant PROOF_BYTES = 16 * 32;

    IGroth16Verifier private immutable _verifier;
    IPolicyRegistry private immutable _registry;
    ISquareJob private immutable _squareJob;

    address private _hook;
    uint64 private _timestampTolerance;

    mapping(bytes32 statement => bool) private _consumed;

    event HookUpdated(address indexed hook);
    event TimestampToleranceUpdated(uint64 seconds_);
    event ReleaseVerified(uint256 indexed jobId, address indexed payee, uint256 amount, bytes32 statement);
    event VerdictDisagreed(uint256 indexed jobId, IPolicyRegistry.Verdict verdict);
    event ReleaseRefused(uint256 indexed jobId, bytes32 reason);

    error OnlyHook();
    error ProofDoesNotVerify();
    error ZeroAddress();

    /// @dev Reasons carried by `ReleaseRefused`. An operator reading a refusal
    ///      needs to know which binding failed; a boolean tells them only that
    ///      one did.
    bytes32 private constant R_MALFORMED = "malformed proof";
    bytes32 private constant R_INVALID = "invalid proof";
    bytes32 private constant R_NOT_COMPLIANT = "is_compliant is 0";
    bytes32 private constant R_POLICY = "policy commitment";
    bytes32 private constant R_RECIPIENT = "recipient";
    bytes32 private constant R_AMOUNT = "amount";
    bytes32 private constant R_TOKEN = "token";
    bytes32 private constant R_DAILY_SPENT = "daily_spent_before";
    bytes32 private constant R_TIMESTAMP = "timestamp outside window";
    bytes32 private constant R_STRIPE = "stripe_receipt_hash";
    bytes32 private constant R_CONSUMED = "proof already used";
    bytes32 private constant R_CEILING = "daily ceiling";

    modifier onlyHook() {
        if (msg.sender != _hook) revert OnlyHook();
        _;
    }

    /// @param timestampTolerance_ How far `current_unix_timestamp` may sit from
    ///        `block.timestamp`, in seconds, in either direction. It has to
    ///        cover the time between building a proof and it being mined, and
    ///        every second of it is a second in which a policy's time window
    ///        can be straddled. Kept small and owner-adjustable rather than
    ///        immutable, because the right value is a property of the chain's
    ///        block time and the keeper's cadence, not of this code.
    constructor(
        address verifier_,
        address registry_,
        address squareJob_,
        address initialOwner,
        uint64 timestampTolerance_
    ) Ownable(initialOwner) {
        if (verifier_ == address(0) || registry_ == address(0) || squareJob_ == address(0)) {
            revert ZeroAddress();
        }
        _verifier = IGroth16Verifier(verifier_);
        _registry = IPolicyRegistry(registry_);
        _squareJob = ISquareJob(squareJob_);
        _timestampTolerance = timestampTolerance_;
        emit TimestampToleranceUpdated(timestampTolerance_);
    }

    // ------------------------------------------------------------ administration

    /// @notice The hook allowed to spend the verdict's side effects.
    /// @dev `checkRelease` writes — the counter and the consumed mark — so it is
    ///      restricted. `previewRelease` is not: it is `view`, and a verdict
    ///      anybody can read is a verdict anybody can check.
    function setHook(address hook_) external onlyOwner {
        _hook = hook_;
        emit HookUpdated(hook_);
    }

    function setTimestampTolerance(uint64 seconds_) external onlyOwner {
        _timestampTolerance = seconds_;
        emit TimestampToleranceUpdated(seconds_);
    }

    // ------------------------------------------------------------------ verdict

    /// @inheritdoc IComplianceModule
    function previewRelease(
        uint256 jobId,
        address payee,
        uint256 amount,
        address token,
        address client,
        bytes calldata proof
    ) external view returns (bool verified) {
        (verified,,) = _verify(jobId, payee, amount, token, client, proof);
    }

    /// @inheritdoc IComplianceModule
    function checkRelease(
        uint256 jobId,
        address payee,
        uint256 amount,
        address token,
        address client,
        bytes calldata proof
    ) external onlyHook returns (bool verified) {
        bytes32 reason;
        bytes32 statement;
        (verified, reason, statement) = _verify(jobId, payee, amount, token, client, proof);
        if (!verified) {
            emit ReleaseRefused(jobId, reason);
            return false;
        }

        _consumed[statement] = true;

        // Advances the poster's day by exactly what the payee receives.
        //
        // Since square#194 this returns a verdict rather than reverting on
        // policy grounds, so the ceiling is no longer something that could
        // revert here. `_bindings` checks it anyway, because the ceiling is a
        // condition of payment and not a report afterwards -- and a proof that
        // got this far was already measured against the same counter this call
        // is about to advance.
        //
        // The verdict is read rather than discarded. A proof that passed every
        // binding and still comes back NoPolicy or LimitExceeded means the two
        // contracts have drifted apart, and that should be visible on the day it
        // happens rather than as money moving under a policy nobody checked.
        (, IPolicyRegistry.Verdict verdict) = _registry.recordSpend(client, amount);
        if (verdict != IPolicyRegistry.Verdict.Compliant) {
            emit VerdictDisagreed(jobId, verdict);
        }

        emit ReleaseVerified(jobId, payee, amount, statement);
        return true;
    }

    // ------------------------------------------------------------------ internals

    /// @dev Split across three functions rather than written as one, because
    ///      the proof's four components and the eight signals together overflow
    ///      the EVM's addressable stack. `via_ir` would also solve it and is
    ///      left off: turning it on changes the bytecode of every contract in
    ///      this repository, and the deployed addresses with it.
    function _verify(
        uint256 jobId,
        address payee,
        uint256 amount,
        address token,
        address client,
        bytes calldata proof
    ) private view returns (bool, bytes32, bytes32) {
        jobId; // bound through payee and amount, which the hook resolved from it

        // Every component is a fixed-size type, so a well-formed proof is
        // exactly (2 + 4 + 2 + 8) words.
        if (proof.length != PROOF_BYTES) return (false, R_MALFORMED, bytes32(0));

        uint256[8] memory input;
        // An external call so the decode and the pairing can be caught. A revert
        // reaching `SquareJob._resolvePayout` is the escrow lock #100 removed,
        // so nothing on this path is allowed to throw.
        try this.verifiedSignals(proof) returns (uint256[8] memory signals) {
            input = signals;
        } catch {
            return (false, R_INVALID, bytes32(0));
        }

        // The mark is keyed on the statement, not on the bytes that carried it.
        //
        // A Groth16 proof is not bound to its own encoding. For a valid
        // (A, B, C) and any r, s, the triple (rA, r⁻¹B + sδ, C + rsA) verifies
        // for the same public signals, and the pairing is all this verifier
        // checks. Measured against src/Groth16Verifier.sol itself in
        // test/Malleability.t.sol: the copy has different bytes, the same eight
        // signals, and the verifier accepts it.
        //
        // So keccak256(proof) marked a representation. A re-randomised copy of a
        // proof already spent has a different hash and the mark never sees it,
        // which matters on the one path the counter does not cover: a proof for
        // the first payment of a day, presented again just after the counter
        // resets at midnight and still inside the timestamp tolerance. Signals 5
        // and 6 both match there, and finalize is permissionless.
        //
        // Re-randomisation cannot touch the signals, so hashing them is what
        // makes "this statement has been spent" true rather than "these bytes
        // have been seen".
        bytes32 statement = keccak256(abi.encode(input));
        if (_consumed[statement]) return (false, R_CONSUMED, statement);

        (bool ok2, bytes32 reason) = _bindings(payee, amount, token, client, input);
        return (ok2, reason, statement);
    }

    /// @notice Decode a proof, check it against the key, and return its signals.
    /// @dev Reverts when the proof is malformed or does not verify; `_verify`
    ///      catches that and turns it into a verdict. `external` because
    ///      Solidity cannot catch a revert in an internal call.
    function verifiedSignals(bytes calldata proof) external view returns (uint256[8] memory input) {
        uint256[2] memory a;
        uint256[2][2] memory b;
        uint256[2] memory c;
        (a, b, c, input) = abi.decode(proof, (uint256[2], uint256[2][2], uint256[2], uint256[8]));
        if (!_verifier.verifyProof(a, b, c, input)) revert ProofDoesNotVerify();
    }

    /// @dev The eight bindings, in the circuit's own order. Signal by signal,
    ///      against this job's storage rather than against the proof itself.
    function _bindings(
        address payee,
        uint256 amount,
        address token,
        address client,
        uint256[8] memory input
    ) private view returns (bool, bytes32) {
        if (input[IS_COMPLIANT] != 1) return (false, R_NOT_COMPLIANT);

        bytes32 commitment = _registry.commitmentOf(client);
        if (commitment == bytes32(0) || input[POLICY_DATA_HASH] != uint256(commitment)) {
            return (false, R_POLICY);
        }

        if (input[RECIPIENT] != uint256(uint160(payee))) return (false, R_RECIPIENT);
        if (input[AMOUNT] != amount) return (false, R_AMOUNT);
        if (input[TOKEN] != uint256(uint160(token))) return (false, R_TOKEN);

        uint256 spentBefore = _registry.spentToday(client);
        if (input[DAILY_SPENT_BEFORE] != spentBefore) return (false, R_DAILY_SPENT);

        if (!_withinWindow(input[CURRENT_UNIX_TIMESTAMP])) return (false, R_TIMESTAMP);

        // The MPP receipt path is not carried on this chain. A non-zero value
        // would be a claim about a trust root that does not exist here.
        if (input[STRIPE_RECEIPT_HASH] != 0) return (false, R_STRIPE);

        // The public ceiling, checked before the release rather than reported
        // after it. square#194 made `recordSpend` return a verdict instead of
        // reverting, so this is no longer about keeping `checkRelease` from
        // throwing; it is about the ceiling being a condition of payment. The
        // registry's own verdict is asserted in `checkRelease` as a second line.
        if (spentBefore + amount > _registry.policyOf(client).dailyLimit) return (false, R_CEILING);

        return (true, bytes32(0));
    }

    function _withinWindow(uint256 stamp) private view returns (bool) {
        uint256 tolerance = _timestampTolerance;
        if (stamp + tolerance < block.timestamp) return false;
        if (stamp > block.timestamp + tolerance) return false;
        return true;
    }

    // --------------------------------------------------------------------- views

    function hook() external view returns (address) {
        return _hook;
    }

    function timestampTolerance() external view returns (uint64) {
        return _timestampTolerance;
    }

    function verifier() external view returns (address) {
        return address(_verifier);
    }

    function policyRegistry() external view returns (address) {
        return address(_registry);
    }

    function squareJob() external view returns (address) {
        return address(_squareJob);
    }

    /// @param statement `keccak256(abi.encode(publicSignals))`, not a hash of the
    ///        proof bytes: a Groth16 proof can be re-randomised into different
    ///        bytes for the same signals, so the bytes are not what was spent.
    function isConsumed(bytes32 statement) external view returns (bool) {
        return _consumed[statement];
    }

    /// @notice How many public signals this module binds.
    /// @dev Read by the test that fails when the circuit grows a signal nobody
    ///      bound. A number here and a number in the verifier that disagree is
    ///      the failure this exists to make loud.
    function boundSignalCount() external pure returns (uint256) {
        return SIGNAL_COUNT;
    }
}
