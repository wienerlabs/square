// The parts of Circle's CCTP V2 contracts this package calls or decodes,
// from circlefin/evm-cctp-contracts (src/v2/TokenMessengerV2.sol,
// src/v2/MessageTransmitterV2.sol, src/v2/BaseTokenMessenger.sol). The
// `DepositForBurn` shape below is the one the deployed testnet contracts emit
// (checked against Ethereum Sepolia's logs, 314 in 2 000 blocks on
// 2026-09-15), which is not the shape every page of the documentation shows.

export const tokenMessengerV2Abi = [
  {
    type: "function",
    name: "depositForBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "remoteTokenMessengers",
    stateMutability: "view",
    inputs: [{ name: "domain", type: "uint32" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "messageBodyVersion",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint32" }],
  },
  {
    type: "event",
    name: "DepositForBurn",
    inputs: [
      { name: "burnToken", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "depositor", type: "address", indexed: true },
      { name: "mintRecipient", type: "bytes32", indexed: false },
      { name: "destinationDomain", type: "uint32", indexed: false },
      { name: "destinationTokenMessenger", type: "bytes32", indexed: false },
      { name: "destinationCaller", type: "bytes32", indexed: false },
      { name: "maxFee", type: "uint256", indexed: false },
      { name: "minFinalityThreshold", type: "uint32", indexed: true },
      { name: "hookData", type: "bytes", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MintAndWithdraw",
    inputs: [
      { name: "mintRecipient", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "mintToken", type: "address", indexed: true },
      { name: "feeCollected", type: "uint256", indexed: false },
    ],
  },
] as const;

export const messageTransmitterV2Abi = [
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
  {
    type: "function",
    name: "usedNonces",
    stateMutability: "view",
    inputs: [{ name: "nonce", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "localDomain",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint32" }],
  },
  {
    type: "event",
    name: "MessageSent",
    inputs: [{ name: "message", type: "bytes", indexed: false }],
  },
  {
    type: "event",
    name: "MessageReceived",
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "sourceDomain", type: "uint32", indexed: false },
      { name: "nonce", type: "bytes32", indexed: true },
      { name: "sender", type: "bytes32", indexed: false },
      { name: "finalityThresholdExecuted", type: "uint32", indexed: true },
      { name: "messageBody", type: "bytes", indexed: false },
    ],
  },
] as const;
