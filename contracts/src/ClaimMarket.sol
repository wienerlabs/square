// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IClaimMarket} from "./interfaces/IClaimMarket.sol";
import {IKeeperEvaluator} from "./interfaces/IKeeperEvaluator.sol";
import {ISquareJob} from "./interfaces/ISquareJob.sol";

contract ClaimMarket is IClaimMarket, ReentrancyGuard {
    using SafeERC20 for IERC20;

    ISquareJob private immutable _squareJob;
    IKeeperEvaluator private immutable _keeperEvaluator;
    IERC20 private immutable _token;

    mapping(uint256 jobId => Listing) private _listings;

    constructor(address squareJob_, address keeperEvaluator_) {
        _squareJob = ISquareJob(squareJob_);
        _keeperEvaluator = IKeeperEvaluator(keeperEvaluator_);
        _token = IERC20(_squareJob.paymentToken());
    }

    function list(uint256 jobId, uint64 price) external nonReentrant {
        ISquareJob.JobRecord memory job = _liveJob(jobId);
        if (msg.sender != job.provider) revert OnlyProvider();
        Listing storage listing = _listings[jobId];
        if (listing.status == Status.Listed || listing.status == Status.Sold) revert ListingActive();
        uint256 face = _squareJob.netPayout(jobId);
        if (price == 0 || price >= face) revert BadPrice();

        listing.seller = msg.sender;
        listing.buyer = address(0);
        listing.price = price;
        listing.faceValue = uint64(face);
        listing.status = Status.Listed;
        emit ClaimListed(jobId, msg.sender, price, uint64(face));
    }

    function buy(uint256 jobId) external nonReentrant {
        Listing storage listing = _listings[jobId];
        if (listing.status != Status.Listed) revert NotListed();
        ISquareJob.JobRecord memory job = _liveJob(jobId);
        if (msg.sender == listing.seller || msg.sender == job.provider) revert BuyerIsSeller();
        if (msg.sender == job.client) revert BuyerIsClient();

        listing.buyer = msg.sender;
        listing.status = Status.Sold;
        emit ClaimBought(jobId, msg.sender, listing.seller, listing.price);
        _token.safeTransferFrom(msg.sender, listing.seller, listing.price);
    }

    function cancel(uint256 jobId) external {
        Listing storage listing = _listings[jobId];
        if (listing.status != Status.Listed) revert NotListed();
        if (msg.sender != listing.seller) revert OnlySeller();
        listing.status = Status.Cancelled;
        emit ClaimCancelled(jobId, msg.sender);
    }

    function payeeOf(uint256 jobId) external view returns (address) {
        Listing storage listing = _listings[jobId];
        if (listing.status == Status.Sold) return listing.buyer;
        return _squareJob.getJobRecord(jobId).provider;
    }

    function getListing(uint256 jobId) external view returns (Listing memory) {
        return _listings[jobId];
    }

    function _liveJob(uint256 jobId) private view returns (ISquareJob.JobRecord memory job) {
        job = _squareJob.getJobRecord(jobId);
        if (job.status != ISquareJob.JobStatus.Submitted) revert NotSubmitted();
        if (job.evaluator != address(_keeperEvaluator)) revert NotOptimisticJob();
        if (_keeperEvaluator.isDisputed(jobId)) revert Disputed();
    }
}
