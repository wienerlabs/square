import { ARC_TESTNET_CHAIN_ID as CORE_ARC_TESTNET_CHAIN_ID } from "@squaresdk/core";
import type { Address } from "viem";
import { entryPoint07Address } from "viem/account-abstraction";

/** Declared in @squaresdk/core; re-exported so this package keeps one name for it. */
export const ARC_TESTNET_CHAIN_ID = CORE_ARC_TESTNET_CHAIN_ID;

/**
 * The three addresses below are not deployments of ours and are not chain
 * specific: ERC-4337 v0.7 ships them through a deterministic deployer, so the
 * same bytecode sits at the same address on every chain that has it. Checked
 * with eth_getCode on 2026-09-09: on Arc testnet and on Base mainnet the
 * factory returns the same 2288 bytes and the implementation the same 7792,
 * hash for hash. That is why they stay constants here instead of moving into
 * the per-chain registry, which holds only addresses that differ per chain.
 */
export const ENTRY_POINT_V07: Address = entryPoint07Address;

export const SIMPLE_ACCOUNT_FACTORY_V07: Address = "0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985";

export const SIMPLE_ACCOUNT_IMPLEMENTATION_V07: Address = "0x68641DE71cfEa5a5d0D29712449Ee254bb1400C2";

export const ARC_OBSERVED_GAS_PRICE_WEI = 20_000_000_000n;

export const NATIVE_USDC_DECIMALS = 18;
