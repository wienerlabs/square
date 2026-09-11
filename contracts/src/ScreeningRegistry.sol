// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IScreeningRegistry} from "./interfaces/IScreeningRegistry.sol";

/// @title ScreeningRegistry
/// @notice square#35: the signed sanctions screenings the hook reads at
///         funding and at release. See IScreeningRegistry and
///         docs/decisions/sanctions-screening.md.
///
/// The EIP-712 domain binds the chain id and this contract's address, so a
/// screening signed for one registry, or one chain, is not a screening here.
contract ScreeningRegistry is IScreeningRegistry, EIP712, Ownable2Step {
    bytes32 public constant SCREENING_TYPEHASH =
        keccak256("Screening(address subject,bool sanctioned,uint64 screenedAt,bytes32 source,bytes32 evidence)");

    /// A minute is the shortest lifetime that survives the gap between a
    /// screener answering and its transaction being mined; a week is the
    /// longest a record should stand in for a list that is updated daily.
    uint64 public constant MIN_MAX_AGE = 1 minutes;
    uint64 public constant MAX_MAX_AGE = 7 days;

    mapping(address subject => Record) private _records;
    mapping(address screener => bool) private _screeners;
    uint64 private _maxAge;

    constructor(address initialOwner, uint64 maxAge_) EIP712("Square Screening", "1") Ownable(initialOwner) {
        _setMaxAge(maxAge_);
    }

    // ------------------------------------------------------------ screenings

    /// @inheritdoc IScreeningRegistry
    function submit(Screening calldata screening, bytes calldata signature) external {
        _submit(screening, signature);
    }

    /// @inheritdoc IScreeningRegistry
    function submitMany(Screening[] calldata screenings, bytes[] calldata signatures) external {
        if (screenings.length != signatures.length) revert LengthMismatch();
        for (uint256 i = 0; i < screenings.length; i++) {
            _submit(screenings[i], signatures[i]);
        }
    }

    function _submit(Screening calldata screening, bytes calldata signature) private {
        if (screening.subject == address(0)) revert ZeroAddress();
        address signer = ECDSA.recoverCalldata(_digest(screening), signature);
        if (!_screeners[signer]) revert NotAScreener(signer);
        if (screening.screenedAt > block.timestamp) {
            revert ScreenedInTheFuture(screening.screenedAt, block.timestamp);
        }
        if (block.timestamp - screening.screenedAt > _maxAge) revert ScreeningTooOld(screening.screenedAt, _maxAge);

        Record storage record = _records[screening.subject];
        if (screening.screenedAt <= record.screenedAt) {
            revert NotNewerThanRecorded(screening.subject, screening.screenedAt, record.screenedAt);
        }
        record.screener = signer;
        record.screenedAt = screening.screenedAt;
        record.sanctioned = screening.sanctioned;
        record.source = screening.source;
        record.evidence = screening.evidence;
        emit Screened(
            screening.subject, screening.sanctioned, screening.screenedAt, screening.source, screening.evidence, signer
        );
    }

    // -------------------------------------------------------- administration

    /// @inheritdoc IScreeningRegistry
    function setScreener(address screener, bool allowed) external onlyOwner {
        if (screener == address(0)) revert ZeroAddress();
        _screeners[screener] = allowed;
        emit ScreenerUpdated(screener, allowed);
    }

    /// @inheritdoc IScreeningRegistry
    function setMaxAge(uint64 maxAge_) external onlyOwner {
        _setMaxAge(maxAge_);
    }

    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    function _setMaxAge(uint64 maxAge_) private {
        if (maxAge_ < MIN_MAX_AGE || maxAge_ > MAX_MAX_AGE) revert MaxAgeOutOfRange(maxAge_);
        _maxAge = maxAge_;
        emit MaxAgeUpdated(maxAge_);
    }

    // ----------------------------------------------------------------- views

    /// @inheritdoc IScreeningRegistry
    function isCleared(address subject) external view returns (bool) {
        Record storage record = _records[subject];
        return record.screenedAt != 0 && !record.sanctioned && _screeners[record.screener]
            && block.timestamp - record.screenedAt <= _maxAge;
    }

    /// @inheritdoc IScreeningRegistry
    function screeningOf(address subject) external view returns (Record memory) {
        return _records[subject];
    }

    /// @inheritdoc IScreeningRegistry
    function isScreener(address account) external view returns (bool) {
        return _screeners[account];
    }

    /// @inheritdoc IScreeningRegistry
    function maxAge() external view returns (uint64) {
        return _maxAge;
    }

    /// @inheritdoc IScreeningRegistry
    function digestOf(Screening calldata screening) external view returns (bytes32) {
        return _digest(screening);
    }

    function _digest(Screening calldata screening) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SCREENING_TYPEHASH,
                    screening.subject,
                    screening.sanctioned,
                    screening.screenedAt,
                    screening.source,
                    screening.evidence
                )
            )
        );
    }
}
