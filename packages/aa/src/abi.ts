import { parseAbi } from "viem";

export const simpleAccountAbi = parseAbi([
  "function execute(address dest, uint256 value, bytes func)",
  "function executeBatch(address[] dest, uint256[] value, bytes[] func)",
  "function owner() view returns (address)",
  "function entryPoint() view returns (address)",
  "function getDeposit() view returns (uint256)",
  "function addDeposit() payable",
  "function withdrawDepositTo(address withdrawAddress, uint256 amount)",
  "function initialize(address anOwner)",
  "event SimpleAccountInitialized(address indexed entryPoint, address indexed owner)",
]);

export const simpleAccountFactoryAbi = parseAbi([
  "function createAccount(address owner, uint256 salt) returns (address ret)",
  "function getAddress(address owner, uint256 salt) view returns (address)",
  "function accountImplementation() view returns (address)",
]);
