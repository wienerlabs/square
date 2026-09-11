// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title Sanctions screenings, as signed by a registered screener
/// @notice square#35. A screening is an off-chain answer to "is this address
///         designated", signed under EIP-712 by a screener this registry's
///         owner registered, and kept here so the hook can ask about a party
///         without trusting whoever sent the transaction.
///
/// The decision, and why the answer is not an ERC-8004 validation, is in
/// docs/decisions/sanctions-screening.md. Two properties are load-bearing:
///
/// - **Empty means nobody is cleared.** `isCleared` is true only for a record
///   that exists, is not sanctioned, is younger than `maxAge`, and was signed
///   by a screener that is still registered. A registry with no screener
///   running clears no one, so installing screening without running it stops
///   funding instead of waving it through.
/// - **Newer wins, older is refused.** A record replaces the one held only if
///   it was screened later, so a "cleared" kept back from before a
///   designation cannot overwrite the "sanctioned" that followed it.
interface IScreeningRegistry {
    /// @notice What a screener signs.
    /// @param subject     The address screened.
    /// @param sanctioned  What the source answered.
    /// @param screenedAt  When the source answered, in seconds.
    /// @param source      Which source and API answered, e.g. "trm-sanctions-v1".
    /// @param evidence    keccak256 of the source's raw response, so the record
    ///        can be held against what the source actually returned.
    struct Screening {
        address subject;
        bool sanctioned;
        uint64 screenedAt;
        bytes32 source;
        bytes32 evidence;
    }

    /// @notice What the registry holds per address: the latest screening and
    ///         who signed it.
    struct Record {
        address screener;
        uint64 screenedAt;
        bool sanctioned;
        bytes32 source;
        bytes32 evidence;
    }

    event Screened(
        address indexed subject,
        bool sanctioned,
        uint64 screenedAt,
        bytes32 indexed source,
        bytes32 evidence,
        address indexed screener
    );
    event ScreenerUpdated(address indexed screener, bool allowed);
    event MaxAgeUpdated(uint64 maxAge);

    error ZeroAddress();
    error NotAScreener(address signer);
    error ScreenedInTheFuture(uint64 screenedAt, uint256 blockTimestamp);
    error ScreeningTooOld(uint64 screenedAt, uint64 maxAge);
    error NotNewerThanRecorded(address subject, uint64 screenedAt, uint64 recorded);
    error MaxAgeOutOfRange(uint64 maxAge);
    error LengthMismatch();
    error RenounceDisabled();

    /// @notice Record a screening signed by a registered screener. Anyone may
    ///         submit it; the signature is what is trusted, not the sender.
    function submit(Screening calldata screening, bytes calldata signature) external;

    /// @notice `submit`, for several at once. All or nothing.
    function submitMany(Screening[] calldata screenings, bytes[] calldata signatures) external;

    /// @notice Register or revoke a screener. Revoking it also revokes every
    ///         record it signed, because `isCleared` checks the signer is still
    ///         registered.
    function setScreener(address screener, bool allowed) external;

    /// @notice How long a screening stays good for.
    function setMaxAge(uint64 maxAge) external;

    function isCleared(address subject) external view returns (bool);
    function screeningOf(address subject) external view returns (Record memory);
    function isScreener(address account) external view returns (bool);
    function maxAge() external view returns (uint64);

    /// @notice The EIP-712 digest a screener signs for `screening`, so an
    ///         off-chain signer can check it agrees with the chain.
    function digestOf(Screening calldata screening) external view returns (bytes32);
}
