import { BaseError, isHex, type Address, type Hash, type Hex } from "viem";

export class EntryPointMismatchError extends BaseError {
  override name = "EntryPointMismatchError";
  constructor(expected: Address, actual: Address, version: string) {
    super(
      `smart account targets EntryPoint ${actual} (v${version}); this bundler submits to ${expected} (v0.7)`,
    );
  }
}

export class UserOperationRejectedError extends BaseError {
  override name = "UserOperationRejectedError";
  readonly opIndex: bigint;
  readonly reason: string;
  readonly inner: Hex | undefined;
  constructor(parameters: { opIndex: bigint; reason: string; inner?: Hex | undefined; cause: Error }) {
    super(`UserOperation rejected by EntryPoint: ${parameters.reason}`, { cause: parameters.cause });
    this.opIndex = parameters.opIndex;
    this.reason = parameters.reason;
    this.inner = parameters.inner;
  }
}

export class UserOperationEventNotFoundError extends BaseError {
  override name = "UserOperationEventNotFoundError";
  constructor(userOpHash: Hash, txHash: Hash) {
    super(`transaction ${txHash} was mined without a UserOperationEvent for ${userOpHash}`);
  }
}

export class CallSimulationRevertedError extends BaseError {
  override name = "CallSimulationRevertedError";
  readonly sender: Address;
  readonly callData: Hex;
  readonly data: Hex | undefined;
  constructor(parameters: { sender: Address; callData: Hex; data: Hex | undefined; cause: Error }) {
    super(
      `the UserOperation call from ${parameters.sender} reverts in simulation${
        parameters.data ? ` with ${parameters.data}` : ""
      }; pass callGasLimit explicitly to submit it anyway`,
      { cause: parameters.cause },
    );
    this.sender = parameters.sender;
    this.callData = parameters.callData;
    this.data = parameters.data;
  }
}

export function revertDataOf(error: unknown): Hex | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const carrier = error.walk((candidate) => {
    const data = (candidate as { data?: unknown }).data;
    return typeof data === "string" && isHex(data);
  });
  return carrier ? (carrier as unknown as { data: Hex }).data : undefined;
}

export function isExecutionRevert(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  if (revertDataOf(error) !== undefined) return true;
  return error.walk((candidate) => candidate instanceof Error && /revert/i.test(candidate.message)) !== null;
}
