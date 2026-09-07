import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, type Log } from "viem";
import { decodeSquareLogs, deploymentFor, eventsNamed, squareJobAbi } from "../src/index.js";

const deployment = deploymentFor(31337);
const client = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const provider = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

function jobCreatedLog(jobId: bigint, blockNumber: bigint, logIndex: number, address = deployment.squareJob): Log {
  const topics = encodeEventTopics({
    abi: squareJobAbi,
    eventName: "JobCreated",
    args: { jobId, client, provider },
  });
  const data = encodeAbiParameters(parseAbiParameters("address, uint256, address"), [
    deployment.keeperEvaluator,
    1_900_000_000n,
    deployment.squareHook,
  ]);
  return {
    address,
    topics,
    data,
    blockNumber,
    logIndex,
    transactionHash: "0x" + "ab".repeat(32),
    transactionIndex: 0,
    blockHash: "0x" + "cd".repeat(32),
    removed: false,
  } as Log;
}

describe("decodeSquareLogs", () => {
  it("decodes a kernel event with typed args", () => {
    const [event] = decodeSquareLogs([jobCreatedLog(5n, 10n, 0)], deployment);
    expect(event?.contract).toBe("SquareJob");
    expect(event?.eventName).toBe("JobCreated");
    if (event?.eventName !== "JobCreated") throw new Error("wrong event");
    expect(event.args.jobId).toBe(5n);
    expect(event.args.client).toBe(client);
    expect(event.args.provider).toBe(provider);
    expect(event.args.evaluator).toBe(deployment.keeperEvaluator);
    expect(event.args.expiredAt).toBe(1_900_000_000n);
    expect(event.args.hook).toBe(deployment.squareHook);
  });

  it("ignores logs from addresses outside the deployment", () => {
    const foreign = jobCreatedLog(5n, 10n, 0, "0x000000000000000000000000000000000000dEaD");
    expect(decodeSquareLogs([foreign], deployment)).toEqual([]);
  });

  it("orders by block then log index", () => {
    const logs = [jobCreatedLog(3n, 12n, 1), jobCreatedLog(1n, 11n, 7), jobCreatedLog(2n, 12n, 0)];
    const ids = eventsNamed(decodeSquareLogs(logs, deployment), "JobCreated").map((e) => e.args.jobId);
    expect(ids).toEqual([1n, 2n, 3n]);
  });
});
