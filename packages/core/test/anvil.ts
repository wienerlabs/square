import { mnemonicToAccount } from "viem/accounts";

export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

export function anvilAccount(index: number) {
  return mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index });
}
