// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IACPHook} from "./interfaces/IACPHook.sol";
import {IPayoutResolver} from "./interfaces/IPayoutResolver.sol";
import {IComplianceModule} from "./interfaces/IComplianceModule.sol";
import {IPolicyRegistry} from "./interfaces/IPolicyRegistry.sol";
import {IScreeningRegistry} from "./interfaces/IScreeningRegistry.sol";
import {IClaimMarket} from "./interfaces/IClaimMarket.sol";
import {ISquareJob} from "./interfaces/ISquareJob.sol";
import {IIdentityRegistry, IReputationRegistry, IValidationRegistry} from "./interfaces/IERC8004.sol";

contract SquareHook is IACPHook, IPayoutResolver, ERC165, Ownable2Step {
    uint16 private constant FULL_BPS = 10_000;
    string private constant TAG1 = "square";
    string private constant VALIDATION_TAG = "square.settlement";

    bytes4 private constant SUBMIT_SELECTOR = ISquareJob.submit.selector;
    bytes4 private constant COMPLETE_SELECTOR = ISquareJob.complete.selector;
    bytes4 private constant REJECT_SELECTOR = ISquareJob.reject.selector;
    bytes4 private constant FUND_SELECTOR = ISquareJob.fund.selector;

    ISquareJob private immutable _squareJob;
    address private immutable _paymentToken;
    IClaimMarket private immutable _claimMarket;
    IIdentityRegistry private immutable _identityRegistry;
    IReputationRegistry private immutable _reputationRegistry;
    IValidationRegistry private immutable _validationRegistry;

    uint8 private constant CHECK_NOT_RUN = 0;
    uint8 private constant CHECK_PASSED = 1;
    uint8 private constant CHECK_FAILED = 2;

    IComplianceModule private _complianceModule;
    IScreeningRegistry private _screening;
    address private _trustedEvaluator;
    uint64 private _minReputationBudget;
    /// @dev The bound agent's id plus one, so that zero means "no agent bound".
    ///      Agent id 0 is a real agent: on Arc's Identity Registry it is the
    ///      first registration, with an owner and a wallet. Storing the id
    ///      itself made that agent's jobs look unbound after beforeAction had
    ///      bound them, so no feedback was written and recordExpiry refused
    ///      them (square#300).
    mapping(uint256 jobId => uint256) private _boundAgentPlusOne;
    mapping(uint256 jobId => bytes32) private _validationOf;
    mapping(uint256 jobId => bool) private _recorded;
    mapping(uint256 jobId => bytes32) private _commitmentAtFund;
    uint256 private transient _checkedJob;
    uint8 private transient _checkOutcome;
    uint8 private transient _screenOutcome;
    bytes32 private transient _screenCommitment;

    event AgentBound(uint256 indexed jobId, uint256 indexed agentId, bytes32 validationRequestHash);
    event ComplianceChecked(uint256 indexed jobId, address indexed payee, uint256 amount, bool verified);
    event ReputationRecorded(uint256 indexed jobId, uint256 indexed agentId, uint8 outcome, int128 value);
    event ReputationWriteFailed(uint256 indexed jobId, uint256 indexed agentId, bytes reason);
    event ValidationRecorded(uint256 indexed jobId, bytes32 indexed requestHash, uint8 response);
    event ValidationWriteFailed(uint256 indexed jobId, bytes32 indexed requestHash, bytes reason);
    event ComplianceModuleUpdated(address indexed module);
    event ScreeningUpdated(address indexed registry);
    event ScreeningChecked(uint256 indexed jobId, address indexed payee, bool cleared);
    event ComplianceCheckFailed(uint256 indexed jobId, bytes reason);
    event ReputationPolicyUpdated(address indexed trustedEvaluator, uint64 minReputationBudget);
    event ReputationSkipped(uint256 indexed jobId, uint256 indexed agentId, bytes32 reason);
    event ReleaseUnconfirmed(uint256 indexed jobId, address indexed payee, uint256 amount);
    event PolicyPinned(uint256 indexed jobId, address indexed client, bytes32 commitment);
    event EvidenceUnreadable(uint256 indexed jobId, bytes reason);

    event EvidenceRecorded(
        uint256 indexed jobId,
        address indexed payee,
        uint256 amount,
        address token,
        bytes32 screening,
        uint8 complianceOutcome,
        uint8 screeningOutcome,
        bytes32 commitment
    );

    bytes32 private constant SKIP_UNTRUSTED_EVALUATOR = "untrusted evaluator";
    bytes32 private constant SKIP_BUDGET_BELOW_MINIMUM = "budget below minimum";

    error OnlyKernel();
    error AgentNotOwnedByProvider(uint256 agentId, address provider);
    error ValidationRequestMismatch(bytes32 requestHash);
    error NotExpired();
    error NoPolicy(address client);
    error AlreadyRecorded();
    error NoAgentBound();
    error NotCleared(address subject);

    modifier onlyKernel() {
        if (msg.sender != address(_squareJob)) revert OnlyKernel();
        _;
    }

    constructor(
        address squareJob_,
        address claimMarket_,
        address identityRegistry_,
        address reputationRegistry_,
        address validationRegistry_,
        address initialOwner,
        address trustedEvaluator_,
        uint64 minReputationBudget_
    ) Ownable(initialOwner) {
        _squareJob = ISquareJob(squareJob_);
        _paymentToken = ISquareJob(squareJob_).paymentToken();
        _claimMarket = IClaimMarket(claimMarket_);
        _identityRegistry = IIdentityRegistry(identityRegistry_);
        _reputationRegistry = IReputationRegistry(reputationRegistry_);
        _validationRegistry = IValidationRegistry(validationRegistry_);
        _setReputationPolicy(trustedEvaluator_, minReputationBudget_);
    }

    function setComplianceModule(address module) external onlyOwner {
        _complianceModule = IComplianceModule(module);
        emit ComplianceModuleUpdated(module);
    }

    /// @notice Install, replace or remove the sanctions screening registry.
    ///         square#35; docs/decisions/sanctions-screening.md.
    /// @dev Zero removes it. Installed, it is read at `fund` for the client and
    ///      the provider, where a party that is not cleared reverts the funding,
    ///      and at release for the payee, where it zeroes the provider's split.
    function setScreening(address registry) external onlyOwner {
        _screening = IScreeningRegistry(registry);
        emit ScreeningUpdated(registry);
    }

    function setReputationPolicy(address trustedEvaluator_, uint64 minReputationBudget_) external onlyOwner {
        _setReputationPolicy(trustedEvaluator_, minReputationBudget_);
    }

    /// @notice The payee and the split the kernel will pay.
    /// @dev This is where a compliance verdict becomes money, and the only
    ///      channel the kernel honours. `SquareJob.complete` calls this
    ///      strictly and before anything else, then calls `beforeAction`
    ///      tolerantly, so a module that wants to stop a release has to do it
    ///      here: `providerBps = 0` returns the whole net to the client.
    ///
    ///      Reverting instead would bubble through `_resolvePayout` and leave
    ///      the escrow with no exit at all, which is the lock #100 removed.
    ///      `previewRelease` is specified never to revert, and the call is
    ///      wrapped anyway: an unusable module reads as "not verified" rather
    ///      than as a stuck job. See docs/decisions/hook-failure-modes.md.
    ///
    ///      The split arrives from `optParams`, which the evaluator encodes.
    ///      The proof does not: it is read from the job through
    ///      `complianceProofOf`, where only the client can put it. A
    ///      permissionless crank's bytes therefore decide nothing, which is
    ///      what square#245 closed. With no module installed the proof is not
    ///      read, and with no screening registry installed the payee is not
    ///      screened; with neither, the split arrives from `optParams` as is.
    function resolvePayout(uint256 jobId, bytes calldata data)
        external
        view
        returns (address payee, uint16 providerBps)
    {
        (, bytes memory optParams) = abi.decode(data, (bytes32, bytes));
        (providerBps,) = _decodeComplete(optParams);
        payee = _claimMarket.payeeOf(jobId);

        // No early return when there is no module: screening below still has to
        // run, and returning here would pay an unscreened payee on a hook that
        // screens but gates no proofs.
        if (address(_complianceModule) != address(0)) {
            bytes memory proof = _squareJob.complianceProofOf(jobId);
            if (!_previewsCompliant(jobId, payee, providerBps, proof)) providerBps = 0;
        }
        // square#35. The payee is the address money leaves to, and it need not
        // be the provider screened at funding: a sold receivable pays its buyer,
        // and an address can be designated while the job runs. Not cleared means
        // not paid, through the same split and never a revert.
        if (address(_screening) != address(0) && !_screeningClears(payee)) providerBps = 0;
    }

    /// @dev One external call, so one `try` covers everything that can fail.
    ///
    ///      The kernel reads have to be inside it, not in the argument list: an
    ///      argument to a `try` expression is evaluated before the protected
    ///      call, so a `netPayout` that reverts would bubble out of
    ///      `resolvePayout` -- and that call is strict, so `complete` would
    ///      revert with it. square#194 established the opposite: a check that
    ///      cannot run writes no verdict and settlement is untouched.
    function _previewsCompliant(uint256 jobId, address payee, uint16 providerBps, bytes memory proof)
        private
        view
        returns (bool)
    {
        try this.previewVerdict(jobId, payee, providerBps, proof) returns (bool verified) {
            return verified;
        } catch {
            return false;
        }
    }

    /// @dev A registry that cannot answer clears nobody. The call is caught for
    ///      the reason `_previewsCompliant` catches its own: it runs inside the
    ///      strict `resolvePayout`, where a revert would lock the escrow.
    function _screeningClears(address subject) private view returns (bool) {
        try _screening.isCleared(subject) returns (bool cleared) {
            return cleared;
        } catch {
            return false;
        }
    }

    /// @dev What the release read about its payee, for the ERC-8004 record:
    ///      whether it was cleared, and a commitment to the screening record the
    ///      verdict rests on. A registry that cannot answer clears nobody.
    function _screeningVerdict(address payee) private view returns (bool cleared, bytes32 commitment) {
        cleared = _screeningClears(payee);
        try _screening.screeningOf(payee) returns (IScreeningRegistry.Record memory record) {
            commitment = keccak256(abi.encode(payee, record));
        } catch {}
    }

    /// @notice The compliance verdict for a release, read-only.
    /// @dev `external` so `_previewsCompliant` can catch it; not part of the
    ///      hook's surface. Reverts freely -- everything it touches is a read
    ///      that should succeed, and a failure is a refusal, not a stuck job.
    function previewVerdict(uint256 jobId, address payee, uint16 providerBps, bytes memory proof)
        external
        view
        returns (bool)
    {
        return _complianceModule.previewRelease(
            jobId,
            payee,
            (_squareJob.netPayout(jobId) * providerBps) / FULL_BPS,
            _squareJob.paymentToken(),
            _squareJob.getJobRecord(jobId).client,
            proof
        );
    }

    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external onlyKernel {
        if (selector == SUBMIT_SELECTOR) {
            (, bytes memory optParams) = abi.decode(data, (bytes32, bytes));
            if (optParams.length == 0) return;
            (uint256 agentId, bytes32 requestHash) = abi.decode(optParams, (uint256, bytes32));
            address provider = _squareJob.getJobRecord(jobId).provider;
            if (!_ownsAgent(provider, agentId)) revert AgentNotOwnedByProvider(agentId, provider);
            if (requestHash != bytes32(0) && !_requestBelongsTo(requestHash, agentId)) {
                revert ValidationRequestMismatch(requestHash);
            }
            _boundAgentPlusOne[jobId] = agentId + 1;
            _validationOf[jobId] = requestHash;
            emit AgentBound(jobId, agentId, requestHash);
        } else if (selector == FUND_SELECTOR) {
            // square#35. The last point before money enters escrow, and a strict
            // call: a party that is not cleared reverts the funding and nothing
            // is locked, because the client still holds its USDC.
            if (address(_complianceModule) == address(0) && address(_screening) == address(0)) return;
            ISquareJob.JobRecord memory job = _squareJob.getJobRecord(jobId);
            if (address(_complianceModule) != address(0)) _pinPolicy(jobId, job.client);
            if (address(_screening) == address(0)) return;
            if (!_screening.isCleared(job.client)) revert NotCleared(job.client);
            if (!_screening.isCleared(job.provider)) revert NotCleared(job.provider);
        } else if (selector == COMPLETE_SELECTOR) {
            (, bytes memory optParams) = abi.decode(data, (bytes32, bytes));
            _checkRelease(jobId, optParams);
        }
    }

    function _pinPolicy(uint256 jobId, address client) private {
        address registry = _policyRegistry();
        if (registry == address(0)) return;
        bytes32 commitment = IPolicyRegistry(registry).commitmentOf(client);
        if (commitment == bytes32(0)) revert NoPolicy(client);
        _commitmentAtFund[jobId] = commitment;
        emit PolicyPinned(jobId, client, commitment);
    }

    function _policyRegistry() private view returns (address) {
        try _complianceModule.policyRegistry() returns (address registry) {
            return registry;
        } catch {
            return address(0);
        }
    }

    function commitmentAtFund(uint256 jobId) external view returns (bytes32) {
        return _commitmentAtFund[jobId];
    }

    function proofState(uint256 jobId) external view returns (IComplianceModule.ProofState) {
        if (address(_complianceModule) == address(0)) return IComplianceModule.ProofState.NotGated;
        return _complianceModule.proofState(_squareJob.complianceProofOf(jobId));
    }

    function _checkRelease(uint256 jobId, bytes memory optParams) private {
        (uint16 providerBps,) = _decodeComplete(optParams);
        bytes memory proof = _squareJob.complianceProofOf(jobId);
        address payee = _claimMarket.payeeOf(jobId);
        uint256 amount = (_squareJob.netPayout(jobId) * providerBps) / FULL_BPS;
        uint8 outcome = CHECK_NOT_RUN;
        if (address(_complianceModule) != address(0)) {
            try _complianceModule.checkRelease(
                jobId, payee, amount, _squareJob.paymentToken(), _squareJob.getJobRecord(jobId).client, proof
            ) returns (
                bool ok
            ) {
                outcome = ok ? CHECK_PASSED : CHECK_FAILED;
            } catch (bytes memory reason) {
                outcome = CHECK_FAILED;
                emit ComplianceCheckFailed(jobId, reason);
            }
        }
        _checkedJob = jobId;
        _checkOutcome = outcome;
        emit ComplianceChecked(jobId, payee, amount, outcome == CHECK_PASSED);
        if (address(_screening) != address(0)) {
            (bool cleared, bytes32 commitment) = _screeningVerdict(payee);
            _screenOutcome = cleared ? CHECK_PASSED : CHECK_FAILED;
            _screenCommitment = commitment;
            emit ScreeningChecked(jobId, payee, cleared);
        }
    }

    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external onlyKernel {
        if (selector == COMPLETE_SELECTOR) {
            (bytes32 reason,) = abi.decode(data, (bytes32, bytes));
            bool checked = _checkedJob == jobId;
            uint8 outcome = checked ? _checkOutcome : CHECK_NOT_RUN;
            uint8 screened = checked ? _screenOutcome : CHECK_NOT_RUN;
            bytes32 screening_ = checked ? _screenCommitment : bytes32(0);
            _checkedJob = 0;
            _checkOutcome = CHECK_NOT_RUN;
            _screenOutcome = CHECK_NOT_RUN;
            _screenCommitment = bytes32(0);
            // First, before the registry writes, because they run arbitrary
            // registry code and this is the report worth getting out early.
            //
            // What the ordering does not do is guarantee it. A log belongs to
            // the frame that wrote it: the kernel calls this hook with
            // `{gas: hookGasLimit}` and, if that call fails, emits `HookFailed`
            // and carries on -- and everything this frame emitted goes with the
            // frame, whatever order it was emitted in. A registry that eats the
            // budget rather than reverting takes the report with it, and
            // `test_theUnconfirmedReportIsLostWhenTheHookFrameRunsOut` holds
            // that as it is. Moving the emit into a `try this.…{gas: n}` of its
            // own would not help either: a nested frame's logs are journalled
            // into its parent and discarded with it.
            //
            // So this is best-effort, and the guarantee lives one level up, in
            // the `HookFailed` the kernel emits from its own frame.
            if (outcome != CHECK_PASSED && address(_complianceModule) != address(0)) _reportUnconfirmed(jobId);
            _writeReputation(jobId, 1, "completed", reason);
            (bytes32 evidence, bool paid) = _settlementEvidence(jobId, screening_, outcome, screened);
            if (evidence == bytes32(0)) return;
            _writeValidation(jobId, paid ? 100 : 0, evidence);
        } else if (selector == REJECT_SELECTOR) {
            if (_squareJob.getJobRecord(jobId).submittedAt == 0) return;
            (bytes32 reason,) = abi.decode(data, (bytes32, bytes));
            _writeReputation(jobId, -1, "rejected", reason);
            (bytes32 evidence,) = _settlementEvidence(jobId, bytes32(0), CHECK_NOT_RUN, CHECK_NOT_RUN);
            if (evidence == bytes32(0)) return;
            _writeValidation(jobId, 0, evidence);
        }
    }

    /// @dev A release the kernel paid and the compliance check did not confirm.
    ///
    ///      `resolvePayout` zeroes the split whenever the preview refuses, so a
    ///      non-zero split on a job whose check did not pass means the preview
    ///      said yes and the check -- the counter and the replay mark -- did not
    ///      land: the module reverted, ran out of gas, or could not book the
    ///      spend. `_checkRelease` alone cannot tell that apart from an ordinary
    ///      refusal, because the kernel writes the split it applied only after
    ///      `beforeAction`; here it has. The payment cannot be undone, so it is
    ///      reported by name and with the amount instead of passing as one more
    ///      `verified = false` (#225).
    function _reportUnconfirmed(uint256 jobId) private {
        ISquareJob.JobRecord memory job = _squareJob.getJobRecord(jobId);
        if (job.providerBps == 0) return;
        emit ReleaseUnconfirmed(jobId, job.payee, (_squareJob.netPayout(jobId) * job.providerBps) / FULL_BPS);
    }

    function recordExpiry(uint256 jobId) external {
        ISquareJob.JobRecord memory job = _squareJob.getJobRecord(jobId);
        if (job.status != ISquareJob.JobStatus.Expired) revert NotExpired();
        if (_boundAgentPlusOne[jobId] == 0) revert NoAgentBound();
        if (_recorded[jobId]) revert AlreadyRecorded();
        _writeReputation(jobId, 0, "expired", job.deliverable);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC165, IERC165) returns (bool) {
        return interfaceId == type(IACPHook).interfaceId || interfaceId == type(IPayoutResolver).interfaceId
            || super.supportsInterface(interfaceId);
    }

    function complianceModule() external view returns (address) {
        return address(_complianceModule);
    }

    function screening() external view returns (address) {
        return address(_screening);
    }

    function trustedEvaluator() external view returns (address) {
        return _trustedEvaluator;
    }

    function minReputationBudget() external view returns (uint64) {
        return _minReputationBudget;
    }

    /// @notice The agent bound to `jobId` by its submit. Reverts with
    ///         NoAgentBound when none is: agent id 0 exists, so no id can
    ///         stand for "none" (square#300). `boundAgentOf` is the form that
    ///         answers both questions without reverting.
    function agentOf(uint256 jobId) external view returns (uint256) {
        uint256 slot = _boundAgentPlusOne[jobId];
        if (slot == 0) revert NoAgentBound();
        return slot - 1;
    }

    /// @notice Whether an agent is bound to `jobId`, and which. `agentId` is
    ///         meaningful only when `bound` is true.
    function boundAgentOf(uint256 jobId) external view returns (bool bound, uint256 agentId) {
        uint256 slot = _boundAgentPlusOne[jobId];
        if (slot == 0) return (false, 0);
        return (true, slot - 1);
    }

    function validationOf(uint256 jobId) external view returns (bytes32) {
        return _validationOf[jobId];
    }

    function recorded(uint256 jobId) external view returns (bool) {
        return _recorded[jobId];
    }

    function squareJob() external view returns (address) {
        return address(_squareJob);
    }

    function claimMarket() external view returns (address) {
        return address(_claimMarket);
    }

    function payoutMarket() external view returns (address) {
        return address(_claimMarket);
    }

    function _decodeComplete(bytes memory optParams)
        private
        pure
        returns (uint16 providerBps, bytes memory proof)
    {
        if (optParams.length == 0) return (FULL_BPS, "");
        (providerBps, proof) = abi.decode(optParams, (uint16, bytes));
    }

    function _ownsAgent(address provider, uint256 agentId) private view returns (bool) {
        if (_identityRegistry.ownerOf(agentId) == provider) return true;
        try _identityRegistry.getAgentWallet(agentId) returns (address wallet) {
            return wallet == provider;
        } catch {
            return false;
        }
    }

    function _requestBelongsTo(bytes32 requestHash, uint256 agentId) private view returns (bool) {
        (address validator, uint256 requestedAgent,,,,) = _validationRegistry.getValidationStatus(requestHash);
        return validator == address(this) && requestedAgent == agentId;
    }

    function _setReputationPolicy(address trustedEvaluator_, uint64 minReputationBudget_) private {
        _trustedEvaluator = trustedEvaluator_;
        _minReputationBudget = minReputationBudget_;
        emit ReputationPolicyUpdated(trustedEvaluator_, minReputationBudget_);
    }

    function _writeReputation(uint256 jobId, int128 value, string memory tag2, bytes32 feedbackHash) private {
        uint256 slot = _boundAgentPlusOne[jobId];
        if (slot == 0 || _recorded[jobId]) return;
        uint256 agentId = slot - 1;
        _recorded[jobId] = true;
        if (value > 0) {
            ISquareJob.JobRecord memory job = _squareJob.getJobRecord(jobId);
            if (job.evaluator != _trustedEvaluator) {
                emit ReputationSkipped(jobId, agentId, SKIP_UNTRUSTED_EVALUATOR);
                return;
            }
            if (job.budget < _minReputationBudget) {
                emit ReputationSkipped(jobId, agentId, SKIP_BUDGET_BELOW_MINIMUM);
                return;
            }
        }
        uint8 outcome = value > 0 ? 1 : value < 0 ? 2 : 3;
        try _reputationRegistry.giveFeedback(agentId, value, 0, TAG1, tag2, "", "", feedbackHash) {
            emit ReputationRecorded(jobId, agentId, outcome, value);
        } catch (bytes memory reason) {
            emit ReputationWriteFailed(jobId, agentId, reason);
        }
    }

    function settlementFacts(uint256 jobId) external view returns (address payee, uint256 amount, address token) {
        (payee, amount) = _squareJob.payoutOf(jobId);
        token = _paymentToken;
    }

    function _settlementEvidence(uint256 jobId, bytes32 screening, uint8 complianceOutcome, uint8 screeningOutcome)
        private
        returns (bytes32 commitment, bool paid)
    {
        try this.settlementFacts(jobId) returns (address payee, uint256 amount, address token) {
            commitment =
                keccak256(abi.encode(jobId, payee, amount, token, screening, complianceOutcome, screeningOutcome));
            paid = amount > 0;
            emit EvidenceRecorded(
                jobId, payee, amount, token, screening, complianceOutcome, screeningOutcome, commitment
            );
        } catch (bytes memory reason) {
            emit EvidenceUnreadable(jobId, reason);
        }
    }

    function _writeValidation(uint256 jobId, uint8 response, bytes32 responseHash) private {
        bytes32 requestHash = _validationOf[jobId];
        if (requestHash == bytes32(0)) return;
        try _validationRegistry.validationResponse(requestHash, response, "", responseHash, VALIDATION_TAG) {
            emit ValidationRecorded(jobId, requestHash, response);
        } catch (bytes memory reason) {
            emit ValidationWriteFailed(jobId, requestHash, reason);
        }
    }
}
