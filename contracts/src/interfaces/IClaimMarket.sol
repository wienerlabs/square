// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

interface IClaimMarket {
    enum Status {
        None,
        Listed,
        Sold,
        Cancelled
    }

    struct Listing {
        address seller;
        address buyer;
        uint64 price;
        uint64 faceValue;
        Status status;
    }

    event ClaimListed(uint256 indexed jobId, address indexed seller, uint64 price, uint64 faceValue);
    event ClaimBought(uint256 indexed jobId, address indexed buyer, address indexed seller, uint64 price);
    event ClaimCancelled(uint256 indexed jobId, address indexed seller);

    error NotSubmitted();
    error NotOptimisticJob();
    error OnlyProvider();
    error OnlySeller();
    error Disputed();
    error ListingActive();
    error NotListed();
    error BadPrice();
    error BuyerIsSeller();
    error BuyerIsClient();
    error PayoutNotRouted();
    error PriceMismatch(uint64 expected, uint64 listed);
    error BuyerNotEligible();

    function list(uint256 jobId, uint64 price) external;
    /// @notice Buy a listed receivable at `expectedPrice`, proving the caller
    ///         is a buyer the job's poster approved. square#30.
    /// @param salt         The caller's leaf salt, as the poster issued it.
    /// @param eligibility  The Merkle path from the caller's leaf to
    ///        `IPolicyRegistry.buyerRootOf(job.client)`.
    /// @dev The leaf is computed from `msg.sender`, so a path copied out of
    ///      somebody else's transaction proves nothing for the copier. A poster
    ///      with no list approves nobody, and `BuyerNotEligible` is the answer
    ///      in both cases. See docs/decisions/buyer-eligibility.md.
    function buy(uint256 jobId, uint64 expectedPrice, bytes32 salt, bytes32[] calldata eligibility) external;
    function cancel(uint256 jobId) external;

    function payeeOf(uint256 jobId) external view returns (address);
    function getListing(uint256 jobId) external view returns (Listing memory);
    /// @notice Where the buyer lists live, so a poster can find where to publish one.
    function policyRegistry() external view returns (address);
    /// @notice The leaf `buy` looks for: what an off-chain list builder has to agree with.
    function buyerLeaf(address buyer, bytes32 salt) external pure returns (bytes32);
}
