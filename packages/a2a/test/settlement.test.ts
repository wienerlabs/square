import { describe, it, expect } from "vitest";
import { RpcErrorCode } from "../src/messages.js";
import { A2AServer } from "../src/server.js";
import type { TaskSettlement } from "../src/settlement.js";
import { JobStatus, TaskState } from "../src/states.js";

/**
 * The seam through which a task reaches the chain (square#79). The package
 * holds no client, so the settlement here is a recorder: what the server asks
 * it, in what order, and what it does with the answers.
 */

const CALLER = "did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:892271";

function recorder(options: { admit?: boolean; reason?: string; deliverThrows?: string; status?: JobStatus } = {}) {
  const calls: string[] = [];
  const settlement: TaskSettlement = {
    async admit(jobId, task) {
      calls.push(`admit:${jobId}:${task.capability}:${task.callerDid}`);
      return options.admit === false ? { ok: false, reason: options.reason ?? "job 42 is Open, not Funded" } : { ok: true };
    },
    async deliver(jobId, content, task) {
      calls.push(`deliver:${jobId}:${content}:${task.taskId}:${task.capability}`);
      if (options.deliverThrows) throw new Error(options.deliverThrows);
      return { deliverable: `0x${"ab".repeat(32)}`, reference: `0x${"cd".repeat(32)}` };
    },
    async jobStatus(jobId) {
      calls.push(`jobStatus:${jobId}`);
      return options.status ?? JobStatus.Submitted;
    },
  };
  return { settlement, calls };
}

const createReq = (taskId: string, overrides: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "task/create",
  params: { taskId, capability: "text.echo", input: "hello world", callerDid: CALLER, jobId: "42", ...overrides },
});
const statusReq = (taskId: string) => ({ jsonrpc: "2.0", id: 2, method: "task/status", params: { taskId } });

async function untilTerminal(server: A2AServer, taskId: string) {
  for (let i = 0; i < 50; i += 1) {
    const res = await server.handle(statusReq(taskId));
    const result = res.result as { state: string } | undefined;
    if (result && result.state !== TaskState.Working) return res;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error("task never left WORKING");
}

describe("a settlement decides whether the work is taken", () => {
  it("refuses a job the chain does not show as funded, before any handler runs", async () => {
    let ran = 0;
    const { settlement, calls } = recorder({ admit: false, reason: "job 42 is Open, not Funded" });
    const server = new A2AServer({ handlers: { "text.echo": async ({ input }) => { ran += 1; return input; } }, settlement });
    const res = await server.handle(createReq("t1"));
    expect(res.error?.code).toBe(RpcErrorCode.JobNotFunded);
    expect(res.error?.message).toBe("job 42 is Open, not Funded");
    expect(ran).toBe(0);
    expect(server.machine.get("t1")).toBeNull();
    expect(calls).toEqual([`admit:42:text.echo:${CALLER}`]);
  });

  it("asks the chain only after the cheap refusals", async () => {
    // A request the server refuses anyway must not cost a chain read.
    const { settlement, calls } = recorder();
    const server = new A2AServer({ handlers: { "text.echo": async ({ input }) => input }, settlement });
    expect((await server.handle(createReq("t2", { capability: "text.none" }))).error?.code).toBe(RpcErrorCode.CapabilityNotOffered);
    expect((await server.handle(createReq("t3", { callerDid: "" }))).error?.code).toBe(RpcErrorCode.InvalidParams);
    expect(calls).toEqual([]);
  });
});

describe("a settlement produces DELIVERED", () => {
  it("hands the handler's output to the chain and carries what landed, with the transaction", async () => {
    const { settlement, calls } = recorder({ status: JobStatus.Submitted });
    const server = new A2AServer({ handlers: { "text.echo": async ({ input }) => `summary of ${input}` }, settlement });
    expect((await server.handle(createReq("t4"))).result).toMatchObject({ state: TaskState.Working });
    const res = await untilTerminal(server, "t4");
    expect(res.result).toMatchObject({
      state: TaskState.Delivered,
      deliverable: `0x${"ab".repeat(32)}`,
      reference: `0x${"cd".repeat(32)}`,
      job: { status: JobStatus.Submitted, name: "Submitted" },
    });
    expect(calls.filter((c) => c.startsWith("deliver"))).toEqual([`deliver:42:summary of hello world:t4:text.echo`]);
    // The record carries the same, so a listener persisting it loses nothing.
    expect(server.machine.get("t4")).toMatchObject({ deliverable: `0x${"ab".repeat(32)}`, reference: `0x${"cd".repeat(32)}` });
  });

  it("fails the task with the chain's reason when submit does not land", async () => {
    const { settlement } = recorder({ deliverThrows: "submit reverted: PastExpiry" });
    const server = new A2AServer({ handlers: { "text.echo": async ({ input }) => input }, settlement });
    await server.handle(createReq("t5"));
    const res = await untilTerminal(server, "t5");
    expect(res.result).toMatchObject({ state: TaskState.Failed, reason: "submit reverted: PastExpiry" });
    expect((res.result as { deliverable?: string }).deliverable).toBeUndefined();
  });

  it("reports the job as the chain has it now, read at answer time", async () => {
    // A status poll after the evaluator acted sees Completed without the task
    // machine having stored anything about it.
    const { settlement, calls } = recorder({ status: JobStatus.Completed });
    const server = new A2AServer({ handlers: { "text.echo": async ({ input }) => input }, settlement });
    await server.handle(createReq("t6"));
    const res = await untilTerminal(server, "t6");
    expect(res.result).toMatchObject({ state: TaskState.Delivered, job: { status: JobStatus.Completed, name: "Completed" } });
    expect(calls.filter((c) => c === "jobStatus:42").length).toBeGreaterThan(0);
  });
});

describe("without a settlement the server is the protocol alone", () => {
  it("takes the handler's output as the deliverable and reports no job", async () => {
    const server = new A2AServer({ handlers: { "text.echo": async () => "0xdeadbeef" } });
    await server.handle(createReq("t7"));
    const res = await untilTerminal(server, "t7");
    expect(res.result).toMatchObject({ state: TaskState.Delivered, deliverable: "0xdeadbeef" });
    expect((res.result as { reference?: string }).reference).toBeUndefined();
    expect((res.result as { job?: unknown }).job).toBeUndefined();
  });
});
