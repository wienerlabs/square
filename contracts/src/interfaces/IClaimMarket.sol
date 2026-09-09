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

    function list(uint256 jobId, uint64 price) external;
    function buy(uint256 jobId, uint64 expectedPrice) external;
    function cancel(uint256 jobId) external;

    function payeeOf(uint256 jobId) external view returns (address);
    function getListing(uint256 jobId) external view returns (Listing memory);
}
