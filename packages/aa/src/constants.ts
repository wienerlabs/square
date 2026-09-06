import type { Address } from "viem";
import { entryPoint07Address } from "viem/account-abstraction";

export const ARC_TESTNET_CHAIN_ID = 5042002;

export const ENTRY_POINT_V07: Address = entryPoint07Address;

export const SIMPLE_ACCOUNT_FACTORY_V07: Address = "0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985";

export const SIMPLE_ACCOUNT_IMPLEMENTATION_V07: Address = "0x68641DE71cfEa5a5d0D29712449Ee254bb1400C2";

export const ARC_OBSERVED_GAS_PRICE_WEI = 20_000_000_000n;

export const NATIVE_USDC_DECIMALS = 18;
