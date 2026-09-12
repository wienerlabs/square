// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IIdentityRegistry, IReputationRegistry, IValidationRegistry} from "../../src/interfaces/IERC8004.sol";

contract MockIdentityRegistry is IIdentityRegistry {
    mapping(uint256 => address) private _owners;
    mapping(uint256 => address) private _wallets;
    bool public walletsSupported = true;

    function setAgent(uint256 agentId, address owner, address wallet) external {
        _owners[agentId] = owner;
        _wallets[agentId] = wallet;
    }

    function setWalletsSupported(bool supported) external {
        walletsSupported = supported;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address owner = _owners[tokenId];
        require(owner != address(0), "ERC721: invalid token ID");
        return owner;
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        require(walletsSupported, "not exposed");
        return _wallets[agentId];
    }
}

contract MockReputationRegistry is IReputationRegistry {
    struct Feedback {
        address client;
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        bytes32 feedbackHash;
    }

    mapping(uint256 => Feedback[]) public feedbacks;
    bool public shouldRevert;
    /// @dev Zero unless a test asks for it, so nothing else changes behaviour.
    ///      A registry that reverts is caught by the hook's `try`; one that eats
    ///      the gas is not, and that is the difference the ordering of writes in
    ///      `afterAction` was claimed to survive.
    uint256 public gasToBurn;

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function setGasToBurn(uint256 value) external {
        gasToBurn = value;
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata,
        string calldata,
        bytes32 feedbackHash
    ) external {
        if (gasToBurn > 0) {
            uint256 start = gasleft();
            uint256 x;
            while (start - gasleft() < gasToBurn) x = uint256(keccak256(abi.encode(x)));
        }
        require(!shouldRevert, "registry down");
        feedbacks[agentId].push(Feedback(msg.sender, value, valueDecimals, tag1, tag2, feedbackHash));
    }

    function feedbackCount(uint256 agentId) external view returns (uint256) {
        return feedbacks[agentId].length;
    }

    function feedbackAt(uint256 agentId, uint256 index) external view returns (Feedback memory) {
        return feedbacks[agentId][index];
    }

    function getLastIndex(uint256 agentId, address) external view returns (uint64) {
        return uint64(feedbacks[agentId].length);
    }

    function readFeedback(uint256 agentId, address, uint64 feedbackIndex)
        external
        view
        returns (int128, uint8, string memory, string memory, bool)
    {
        Feedback storage f = feedbacks[agentId][feedbackIndex - 1];
        return (f.value, f.valueDecimals, f.tag1, f.tag2, false);
    }
}

contract MockValidationRegistry is IValidationRegistry {
    struct Response {
        address validator;
        uint8 response;
        string tag;
    }

    mapping(bytes32 => Response) public responses;
    mapping(bytes32 => address) public requestValidator;
    mapping(bytes32 => uint256) public requestAgent;
    bool public shouldRevert;

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function validationRequest(address validatorAddress, uint256 agentId, string calldata, bytes32 requestHash)
        external
    {
        requestValidator[requestHash] = validatorAddress;
        requestAgent[requestHash] = agentId;
    }

    function validationResponse(bytes32 requestHash, uint8 response, string calldata, bytes32, string calldata tag)
        external
    {
        require(!shouldRevert, "registry down");
        require(requestValidator[requestHash] == msg.sender, "not the validator");
        responses[requestHash] = Response(msg.sender, response, tag);
    }

    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (address, uint256, uint8, bytes32, string memory, uint256)
    {
        Response storage r = responses[requestHash];
        return (requestValidator[requestHash], requestAgent[requestHash], r.response, bytes32(0), r.tag, 0);
    }
}
