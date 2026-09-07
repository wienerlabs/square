// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IACPHook} from "./interfaces/IACPHook.sol";
import {IPayoutResolver} from "./interfaces/IPayoutResolver.sol";
import {IComplianceModule} from "./interfaces/IComplianceModule.sol";
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

    ISquareJob private immutable _squareJob;
    IClaimMarket private immutable _claimMarket;
    IIdentityRegistry private immutable _identityRegistry;
    IReputationRegistry private immutable _reputationRegistry;
    IValidationRegistry private immutable _validationRegistry;

    IComplianceModule private _complianceModule;
    mapping(uint256 jobId => uint256) private _agentOf;
    mapping(uint256 jobId => bytes32) private _validationOf;
    mapping(uint256 jobId => bool) private _recorded;
    bool private transient _proofVerified;

    event AgentBound(uint256 indexed jobId, uint256 indexed agentId, bytes32 validationRequestHash);
    event ComplianceChecked(uint256 indexed jobId, address indexed payee, uint256 amount, bool verified);
    event ReputationRecorded(uint256 indexed jobId, uint256 indexed agentId, uint8 outcome, int128 value);
    event ReputationWriteFailed(uint256 indexed jobId, uint256 indexed agentId, bytes reason);
    event ValidationRecorded(uint256 indexed jobId, bytes32 indexed requestHash, uint8 response);
    event ValidationWriteFailed(uint256 indexed jobId, bytes32 indexed requestHash, bytes reason);
    event ComplianceModuleUpdated(address indexed module);

    error OnlyKernel();
    error AgentNotOwnedByProvider(uint256 agentId, address provider);
    error NotExpired();
    error AlreadyRecorded();
    error NoAgentBound();

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
        address initialOwner
    ) Ownable(initialOwner) {
        _squareJob = ISquareJob(squareJob_);
        _claimMarket = IClaimMarket(claimMarket_);
        _identityRegistry = IIdentityRegistry(identityRegistry_);
        _reputationRegistry = IReputationRegistry(reputationRegistry_);
        _validationRegistry = IValidationRegistry(validationRegistry_);
    }

    function setComplianceModule(address module) external onlyOwner {
        _complianceModule = IComplianceModule(module);
        emit ComplianceModuleUpdated(module);
    }

    function resolvePayout(uint256 jobId, bytes calldata data)
        external
        view
        returns (address payee, uint16 providerBps)
    {
        (, bytes memory optParams) = abi.decode(data, (bytes32, bytes));
        (providerBps,) = _decodeComplete(optParams);
        payee = _claimMarket.payeeOf(jobId);
    }

    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external onlyKernel {
        if (selector == SUBMIT_SELECTOR) {
            (, bytes memory optParams) = abi.decode(data, (bytes32, bytes));
            if (optParams.length == 0) return;
            (uint256 agentId, bytes32 requestHash) = abi.decode(optParams, (uint256, bytes32));
            address provider = _squareJob.getJobRecord(jobId).provider;
            if (!_ownsAgent(provider, agentId)) revert AgentNotOwnedByProvider(agentId, provider);
            _agentOf[jobId] = agentId;
            _validationOf[jobId] = requestHash;
            emit AgentBound(jobId, agentId, requestHash);
        } else if (selector == COMPLETE_SELECTOR) {
            (, bytes memory optParams) = abi.decode(data, (bytes32, bytes));
            _checkRelease(jobId, optParams);
        }
    }

    function _checkRelease(uint256 jobId, bytes memory optParams) private {
        (uint16 providerBps, bytes memory proof) = _decodeComplete(optParams);
        address payee = _claimMarket.payeeOf(jobId);
        uint256 amount = (_squareJob.netPayout(jobId) * providerBps) / FULL_BPS;
        bool verified;
        if (address(_complianceModule) != address(0)) {
            verified = _complianceModule.checkRelease(
                jobId, payee, amount, _squareJob.paymentToken(), _squareJob.getJobRecord(jobId).client, proof
            );
        }
        _proofVerified = verified;
        emit ComplianceChecked(jobId, payee, amount, verified);
    }

    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external onlyKernel {
        if (selector == COMPLETE_SELECTOR) {
            (bytes32 reason,) = abi.decode(data, (bytes32, bytes));
            _writeReputation(jobId, 1, "completed", reason);
            if (_proofVerified) {
                _proofVerified = false;
                _writeValidation(jobId, 100);
            }
        } else if (selector == REJECT_SELECTOR) {
            if (_squareJob.getJobRecord(jobId).submittedAt == 0) return;
            (bytes32 reason,) = abi.decode(data, (bytes32, bytes));
            _writeReputation(jobId, -1, "rejected", reason);
            _writeValidation(jobId, 0);
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

    function _writeReputation(uint256 jobId, int128 value, string memory tag2, bytes32 feedbackHash) private {
        uint256 agentId = _agentOf[jobId];
        if (agentId == 0 || _recorded[jobId]) return;
        _recorded[jobId] = true;
        uint8 outcome = value > 0 ? 1 : value < 0 ? 2 : 3;
        try _reputationRegistry.giveFeedback(agentId, value, 0, TAG1, tag2, "", "", feedbackHash) {
            emit ReputationRecorded(jobId, agentId, outcome, value);
        } catch (bytes memory reason) {
            emit ReputationWriteFailed(jobId, agentId, reason);
        }
    }

    function _writeValidation(uint256 jobId, uint8 response) private {
        bytes32 requestHash = _validationOf[jobId];
        if (requestHash == bytes32(0)) return;
        try _validationRegistry.validationResponse(requestHash, response, "", bytes32(0), VALIDATION_TAG) {
            emit ValidationRecorded(jobId, requestHash, response);
        } catch (bytes memory reason) {
            emit ValidationWriteFailed(jobId, requestHash, reason);
        }
    }
}
