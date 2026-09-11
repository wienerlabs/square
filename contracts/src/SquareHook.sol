// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IACPHook} from "./interfaces/IACPHook.sol";
import {IPayoutResolver} from "./interfaces/IPayoutResolver.sol";
import {IComplianceModule} from "./interfaces/IComplianceModule.sol";
import {IScreeningRegistry} from "./interfaces/IScreeningRegistry.sol";
import {IClaimMarket} from "./interfaces/IClaimMarket.sol";
import {ISquareJob} from "./interfaces/ISquareJob.sol";
import {IIdentityRegistry, IReputationRegistry, IValidationRegistry} from "./interfaces/IERC8004.sol";

contract SquareHook is IACPHook, IPayoutResolver, ERC165, Ownable2Step {
    uint16 private constant FULL_BPS = 10_000;
    string private constant TAG1 = "square";
    string private constant VALIDATION_TAG = "square.compliance";

    bytes4 private constant SUBMIT_SELECTOR = ISquareJob.submit.selector;
    bytes4 private constant COMPLETE_SELECTOR = ISquareJob.complete.selector;
    bytes4 private constant REJECT_SELECTOR = ISquareJob.reject.selector;
    bytes4 private constant FUND_SELECTOR = ISquareJob.fund.selector;

    ISquareJob private immutable _squareJob;
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
    mapping(uint256 jobId => uint256) private _agentOf;
    mapping(uint256 jobId => bytes32) private _validationOf;
    mapping(uint256 jobId => bool) private _recorded;
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

    bytes32 private constant SKIP_UNTRUSTED_EVALUATOR = "untrusted evaluator";
    bytes32 private constant SKIP_BUDGET_BELOW_MINIMUM = "budget below minimum";

    error OnlyKernel();
    error AgentNotOwnedByProvider(uint256 agentId, address provider);
    error ValidationRequestMismatch(bytes32 requestHash);
    error NotExpired();
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
    ///      With no module and no screening registry installed nothing changes
    ///      and the split arrives from `optParams` as before.
    function resolvePayout(uint256 jobId, bytes calldata data)
        external
        view
        returns (address payee, uint16 providerBps)
    {
        (, bytes memory optParams) = abi.decode(data, (bytes32, bytes));
        bytes memory proof;
        (providerBps, proof) = _decodeComplete(optParams);
        payee = _claimMarket.payeeOf(jobId);

        if (address(_complianceModule) != address(0) && !_previewsCompliant(jobId, payee, providerBps, proof)) {
            providerBps = 0;
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
            _agentOf[jobId] = agentId;
            _validationOf[jobId] = requestHash;
            emit AgentBound(jobId, agentId, requestHash);
        } else if (selector == FUND_SELECTOR) {
            // square#35. The last point before money enters escrow, and a strict
            // call: a party that is not cleared reverts the funding and nothing
            // is locked, because the client still holds its USDC.
            if (address(_screening) == address(0)) return;
            ISquareJob.JobRecord memory job = _squareJob.getJobRecord(jobId);
            if (!_screening.isCleared(job.client)) revert NotCleared(job.client);
            if (!_screening.isCleared(job.provider)) revert NotCleared(job.provider);
        } else if (selector == COMPLETE_SELECTOR) {
            (, bytes memory optParams) = abi.decode(data, (bytes32, bytes));
            _checkRelease(jobId, optParams);
        }
    }

    function _checkRelease(uint256 jobId, bytes memory optParams) private {
        (uint16 providerBps, bytes memory proof) = _decodeComplete(optParams);
        address payee = _claimMarket.payeeOf(jobId);
        uint256 amount = (_squareJob.netPayout(jobId) * providerBps) / FULL_BPS;
        uint8 outcome = CHECK_NOT_RUN;
        if (address(_complianceModule) != address(0)) {
            try _complianceModule.checkRelease(
                jobId, payee, amount, _squareJob.paymentToken(), _squareJob.getJobRecord(jobId).client, proof
            ) returns (bool ok) {
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
            _writeReputation(jobId, 1, "completed", reason);
            bool checked = _checkedJob == jobId;
            uint8 outcome = checked ? _checkOutcome : CHECK_NOT_RUN;
            uint8 screened = checked ? _screenOutcome : CHECK_NOT_RUN;
            bytes32 screening_ = checked ? _screenCommitment : bytes32(0);
            _checkedJob = 0;
            _checkOutcome = CHECK_NOT_RUN;
            _screenOutcome = CHECK_NOT_RUN;
            _screenCommitment = bytes32(0);
            // The ERC-8004 validation response is the gate's verdict on this
            // release, the same verdict `resolvePayout` turned into the split: 100
            // when every installed check passed and the payee was paid, 0 when the
            // proof or the payee's screening refused it. With screening installed,
            // `responseHash` commits to the screening record the verdict read,
            // which is how square#35's result reaches the ValidationRegistry
            // (docs/decisions/sanctions-screening.md). Nothing installed, nothing
            // written, as before.
            if (outcome == CHECK_NOT_RUN && screened == CHECK_NOT_RUN) return;
            bool passed = outcome != CHECK_FAILED && screened != CHECK_FAILED;
            _writeValidation(jobId, passed ? 100 : 0, screening_);
        } else if (selector == REJECT_SELECTOR) {
            if (_squareJob.getJobRecord(jobId).submittedAt == 0) return;
            (bytes32 reason,) = abi.decode(data, (bytes32, bytes));
            _writeReputation(jobId, -1, "rejected", reason);
            _writeValidation(jobId, 0, bytes32(0));
        }
    }

    function recordExpiry(uint256 jobId) external {
        ISquareJob.JobRecord memory job = _squareJob.getJobRecord(jobId);
        if (job.status != ISquareJob.JobStatus.Expired) revert NotExpired();
        if (_agentOf[jobId] == 0) revert NoAgentBound();
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

    function agentOf(uint256 jobId) external view returns (uint256) {
        return _agentOf[jobId];
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

    function _decodeComplete(bytes memory optParams) private pure returns (uint16 providerBps, bytes memory proof) {
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
        uint256 agentId = _agentOf[jobId];
        if (agentId == 0 || _recorded[jobId]) return;
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
