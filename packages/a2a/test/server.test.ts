import { describe, it, expect } from "vitest";
import { RpcErrorCode, TASK_METHODS, isJsonRpcResponse } from "../src/messages.js";
import { A2AServer } from "../src/server.js";
import { TaskState } from "../src/states.js";

/**
 * The handler on its own, without a socket: what it does with the envelope
 * around a request, as opposed to the task inside it.
 */

const server = new A2AServer({ handlers: { "text.echo": async ({ input }) => input } });

const CALLER = "did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:892271";
const OTHER = "did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:1";

function createReq(taskId: string, overrides: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "task/create",
    params: { taskId, capability: "text.echo", input: "hi", callerDid: CALLER, jobId: "42", ...overrides },
  };
}

const statusReq = (taskId: string) => ({ jsonrpc: "2.0", id: 2, method: "task/status", params: { taskId } });

/** A deferred handler: the test decides when the work finishes. */
function gate() {
  let release!: (value: string) => void;
  const done = new Promise<string>((resolve) => { release = resolve; });
  return { done, release };
}

async function settled(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("JSON-RPC ids", () => {
  it("echoes a string, a number and null exactly as they came", async () => {
    // A caller matches responses to requests by id. JSON-RPC 2.0 allows all
    // three forms, and a server that rewrote a numeric id to "" would hand a
    // caller with several requests in flight answers that match nothing.
    for (const id of ["req-1", 7, 0, null]) {
      const res = await server.handle({ jsonrpc: "2.0", id, method: "task/status", params: { taskId: "nope" } });
      expect(res.id).toBe(id);
      expect(isJsonRpcResponse(res)).toBe(true);
    }
  });

  it("answers null when the request carried no usable id", async () => {
    // What the specification asks for when the id cannot be determined, and
    // where "" would have looked like a real id the caller never sent.
    expect((await server.handle({ jsonrpc: "2.0", method: "task/status", params: {} })).id).toBeNull();
    expect((await server.handle({ jsonrpc: "2.0", id: { nested: true }, method: "task/status" })).id).toBeNull();
    expect((await server.handle("not an object")).id).toBeNull();
    expect((await server.handle({ jsonrpc: "1.0", id: 3, method: "task/status" })).id).toBe(3);
  });
});

describe("the method table", () => {
  it("offers create and status, and nothing that could only ever fail", async () => {
    expect([...TASK_METHODS]).toEqual(["task/create", "task/status"]);
    for (const method of ["task/cancel", "task/complete"]) {
      const res = await server.handle({ jsonrpc: "2.0", id: 1, method, params: { taskId: "t" } });
      expect(res.error?.code).toBe(-32601);
    }
  });
});

describe("who is asking", () => {
  it("takes the body's callerDid at its word when the host says nothing", async () => {
    // The default, and it is a claim: the README says a host that has not
    // authenticated the caller is trusting whatever the body says.
    const agent = new A2AServer({ handlers: { "text.echo": async ({ input }) => input } });
    const res = await agent.handle(createReq("t1", { callerDid: OTHER }));
    expect(res.result).toMatchObject({ taskId: "t1", state: TaskState.Working });
  });

  it("refuses a create whose callerDid is not the authenticated caller", async () => {
    const agent = new A2AServer({ handlers: { "text.echo": async ({ input }) => input } });
    const res = await agent.handle(createReq("t1", { callerDid: OTHER }), { callerDid: CALLER });
    expect(res.error?.code).toBe(RpcErrorCode.InvalidParams);
    expect(res.error?.message).toMatch(/authenticated caller/);
    expect(agent.machine.get("t1")).toBeNull();
  });

  it("shows a task only to the caller that created it", async () => {
    const agent = new A2AServer({ handlers: { "text.echo": async ({ input }) => input } });
    await agent.handle(createReq("t1"), { callerDid: CALLER });
    await settled();
    expect((await agent.handle(statusReq("t1"), { callerDid: CALLER })).result).toMatchObject({ state: TaskState.Delivered });
    // Answered like a missing task: a stranger learns nothing about which ids exist.
    const other = await agent.handle(statusReq("t1"), { callerDid: OTHER });
    expect(other.error?.code).toBe(RpcErrorCode.TaskNotFound);
    expect(other.error?.message).toBe("no such task: t1");
    // A host that does not authenticate still sees it, as before.
    expect((await agent.handle(statusReq("t1"))).result).toMatchObject({ state: TaskState.Delivered });
  });
});

describe("capacity", () => {
  it("answers Busy beyond maxConcurrent and takes work again once a slot frees", async () => {
    const gates = [gate(), gate()];
    let n = 0;
    const agent = new A2AServer({
      maxConcurrent: 2,
      handlers: { "text.slow": async () => gates[n++]!.done },
    });
    const slow = (taskId: string) => createReq(taskId, { capability: "text.slow" });
    expect((await agent.handle(slow("a"))).result).toBeDefined();
    expect((await agent.handle(slow("b"))).result).toBeDefined();
    expect(agent.inFlight).toBe(2);
    const third = await agent.handle(slow("c"));
    expect(third.error?.code).toBe(RpcErrorCode.Busy);
    expect(agent.machine.get("c")).toBeNull();

    gates[0]!.release("0xa");
    await settled();
    expect(agent.inFlight).toBe(1);
    expect((await agent.handle(slow("c"))).result).toBeDefined();
    gates[1]!.release("0xb");
  });

  it("times a handler out, fails the task with the reason, aborts the handler and gives the slot back", async () => {
    // Without this a handler that never settles held its slot for the life
    // of the process: nothing outside run() touches the counter, so
    // machine.fail could mark the record and still not recover the slot.
    let aborted = false;
    const agent = new A2AServer({
      maxConcurrent: 1,
      handlerTimeoutMs: 20,
      handlers: {
        "text.hang": ({ signal }) =>
          new Promise<string>((resolve) => {
            signal.addEventListener("abort", () => { aborted = true; });
            setTimeout(() => resolve("0xlate"), 500);
          }),
        "text.echo": async ({ input }) => input,
      },
    });
    expect((await agent.handle(createReq("hang", { capability: "text.hang" }))).result).toBeDefined();
    expect((await agent.handle(createReq("blocked"))).error?.code).toBe(RpcErrorCode.Busy);

    await new Promise((r) => setTimeout(r, 40));
    const task = agent.machine.get("hang")!;
    expect(task.state).toBe(TaskState.Failed);
    expect(task.reason).toMatch(/timed out after 20ms/);
    expect(aborted).toBe(true);
    expect(agent.inFlight).toBe(0);
    expect((await agent.handle(createReq("after"))).result).toBeDefined();

    // The late resolution changes nothing: the task stays FAILED.
    await new Promise((r) => setTimeout(r, 520));
    expect(agent.machine.get("hang")!.state).toBe(TaskState.Failed);
  });
});

describe("task/create is idempotent on taskId", () => {
  it("answers a repeat of the same request with the task as it stands", async () => {
    // The client retries task/create, and the response to a request that
    // created and started the task can be lost on the way back. The retry
    // carries the same five fields and used to be told "id already used" as
    // an InvalidParams, which the client could not tell from a bad request.
    const agent = new A2AServer({ handlers: { "text.echo": async ({ input }) => input } });
    const first = await agent.handle(createReq("t1"));
    expect(first.result).toMatchObject({ taskId: "t1", state: TaskState.Working });
    await settled();
    const again = await agent.handle(createReq("t1"));
    expect(again.error).toBeUndefined();
    expect(again.result).toMatchObject({ taskId: "t1", state: TaskState.Delivered });
    expect(agent.machine.list()).toHaveLength(1);
  });

  it("refuses the same taskId with different content, with its own code", async () => {
    const agent = new A2AServer({ handlers: { "text.echo": async ({ input }) => input } });
    await agent.handle(createReq("t1"));
    const res = await agent.handle(createReq("t1", { input: "something else" }));
    expect(res.error?.code).toBe(RpcErrorCode.TaskIdInUse);
    expect(res.error?.message).toMatch(/already in use/);
  });
});
