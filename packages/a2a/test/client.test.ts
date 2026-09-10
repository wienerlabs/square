import { describe, it, expect } from "vitest";
import { A2AClient, A2AError } from "../src/client.js";
import { TaskState } from "../src/states.js";

const ENDPOINT = "https://agent.invalid/a2a";
const PARAMS = {
  taskId: "t1",
  capability: "text.summarize",
  input: "a document",
  callerDid: "did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:892271",
  jobId: "42",
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function rpcOk(result: unknown): Response {
  return jsonResponse({ jsonrpc: "2.0", id: "x", result });
}

/** Records every sleep instead of taking it, so backoff is asserted rather than waited out. */
function fakeClock() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => { waits.push(ms); } };
}

describe("retry policy", () => {
  it("retries a 500 and succeeds", async () => {
    const clock = fakeClock();
    let calls = 0;
    const client = new A2AClient({
      sleep: clock.sleep,
      fetch: async () => {
        calls += 1;
        return calls < 3 ? jsonResponse({ err: 1 }, 500) : rpcOk({ taskId: "t1", state: "WORKING" });
      },
    });
    const result = await client.createTask(ENDPOINT, PARAMS);
    expect(result.taskId).toBe("t1");
    expect(calls).toBe(3);
    expect(clock.waits).toEqual([1000, 2000]);
  });

  it("retries a 429", async () => {
    const clock = fakeClock();
    let calls = 0;
    const client = new A2AClient({
      sleep: clock.sleep,
      fetch: async () => {
        calls += 1;
        return calls < 2 ? jsonResponse({}, 429) : rpcOk({ taskId: "t1", state: "WORKING" });
      },
    });
    await client.createTask(ENDPOINT, PARAMS);
    expect(calls).toBe(2);
  });

  it("honours Retry-After over its own curve", async () => {
    const clock = fakeClock();
    let calls = 0;
    const client = new A2AClient({
      sleep: clock.sleep,
      fetch: async () => {
        calls += 1;
        return calls < 2
          ? jsonResponse({}, 429, { "retry-after": "7" })
          : rpcOk({ taskId: "t1", state: "WORKING" });
      },
    });
    await client.createTask(ENDPOINT, PARAMS);
    expect(clock.waits).toEqual([7000]);
  });

  it("does not retry a 400", async () => {
    // A malformed request will be malformed the second time too.
    const clock = fakeClock();
    let calls = 0;
    const client = new A2AClient({
      sleep: clock.sleep,
      fetch: async () => { calls += 1; return jsonResponse({}, 400); },
    });
    await expect(client.createTask(ENDPOINT, PARAMS)).rejects.toThrow(/returned 400/);
    expect(calls).toBe(1);
    expect(clock.waits).toEqual([]);
  });

  it("does not retry a 404", async () => {
    const client = new A2AClient({
      sleep: fakeClock().sleep,
      fetch: async () => jsonResponse({}, 404),
    });
    await expect(client.createTask(ENDPOINT, PARAMS)).rejects.toMatchObject({ status: 404 });
  });

  it("gives up after the configured number of attempts", async () => {
    const clock = fakeClock();
    let calls = 0;
    const client = new A2AClient({
      sleep: clock.sleep,
      maxRetries: 3,
      fetch: async () => { calls += 1; return jsonResponse({}, 503); },
    });
    await expect(client.createTask(ENDPOINT, PARAMS)).rejects.toThrow(/after 3 attempts/);
    expect(calls).toBe(3);
  });

  it("reports a 429 that never clears as busy, not as a server fault", async () => {
    const client = new A2AClient({
      sleep: fakeClock().sleep,
      maxRetries: 2,
      fetch: async () => jsonResponse({}, 429),
    });
    await expect(client.createTask(ENDPOINT, PARAMS)).rejects.toMatchObject({ kind: "busy" });
  });

  it("retries a network error and distinguishes it from a timeout", async () => {
    const client = new A2AClient({
      sleep: fakeClock().sleep,
      maxRetries: 2,
      fetch: async () => { throw new Error("ECONNREFUSED"); },
    });
    await expect(client.createTask(ENDPOINT, PARAMS)).rejects.toMatchObject({ kind: "unreachable" });

    const timingOut = new A2AClient({
      sleep: fakeClock().sleep,
      maxRetries: 1,
      fetch: async () => {
        const e = new Error("The operation was aborted due to timeout");
        e.name = "TimeoutError";
        throw e;
      },
    });
    await expect(timingOut.createTask(ENDPOINT, PARAMS)).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("protocol handling", () => {
  it("refuses a 200 that is not JSON", async () => {
    const client = new A2AClient({
      fetch: async () => new Response("<html>oops</html>", { status: 200 }),
    });
    await expect(client.createTask(ENDPOINT, PARAMS)).rejects.toThrow(/not JSON/);
  });

  it("refuses a 200 that is JSON but not JSON-RPC", async () => {
    // A provider behind a proxy that answers 200 with its own body would
    // otherwise look like a task that silently never progresses.
    const client = new A2AClient({ fetch: async () => jsonResponse({ ok: true }) });
    await expect(client.createTask(ENDPOINT, PARAMS)).rejects.toThrow(/not a JSON-RPC response/);
  });

  it("surfaces a JSON-RPC error as a provider error", async () => {
    const client = new A2AClient({
      fetch: async () => jsonResponse({ jsonrpc: "2.0", id: "x", error: { code: -32000, message: "no such capability" } }),
    });
    await expect(client.createTask(ENDPOINT, PARAMS)).rejects.toThrow(/no such capability/);
  });

  it("refuses a response carrying neither result nor error", async () => {
    const client = new A2AClient({
      fetch: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "x" }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    });
    await expect(client.createTask(ENDPOINT, PARAMS)).rejects.toThrow(/not a JSON-RPC response/);
  });

  it("does not follow a redirect on a task request", async () => {
    // The card names the endpoint that answers. A 3xx on the POST would carry
    // the work and the job id wherever the provider's host pointed, past the
    // endpoint rule that discovery applied; so the request is sent with
    // redirect: "manual" and a 3xx is a provider error, not retried.
    const calls: RequestInit[] = [];
    const client = new A2AClient({
      fetch: async (_input, init) => {
        calls.push(init ?? {});
        return new Response(null, { status: 307, headers: { location: "http://elsewhere.example/a2a" } });
      },
    });
    await expect(client.createTask(ENDPOINT, PARAMS)).rejects.toThrow(/returned 307/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.redirect).toBe("manual");
  });
});

describe("concurrency cap", () => {
  it("refuses beyond the cap and frees the slot afterwards", async () => {
    const clock = fakeClock();
    // Deferred rather than a nullable let: the first status poll parks on this
    // promise, so the slot is provably still held while the second call runs.
    let letFirstFinish!: () => void;
    const held = new Promise<void>((resolve) => { letFirstFinish = resolve; });

    const client = new A2AClient({
      maxConcurrentPerEndpoint: 1,
      sleep: clock.sleep,
      fetch: async (_url, init) => {
        const body = JSON.parse(String((init as RequestInit).body)) as { method: string };
        if (body.method === "task/create") return rpcOk({ taskId: "t1", state: "WORKING" });
        await held;
        return rpcOk({ taskId: "t1", state: TaskState.Delivered, deliverable: "0xabc", updatedAt: "now" });
      },
    });

    const first = client.runTask(ENDPOINT, PARAMS, { pollIntervalMs: 0 });
    await new Promise((r) => setTimeout(r, 10));
    expect(client.inFlight(ENDPOINT)).toBe(1);

    await expect(client.runTask(ENDPOINT, PARAMS)).rejects.toMatchObject({ kind: "at-capacity" });

    letFirstFinish();
    await first;
    expect(client.inFlight(ENDPOINT)).toBe(0);
  });

  it("frees the slot when the task throws", async () => {
    const client = new A2AClient({
      maxConcurrentPerEndpoint: 1,
      sleep: fakeClock().sleep,
      maxRetries: 1,
      fetch: async () => jsonResponse({}, 400),
    });
    await expect(client.runTask(ENDPOINT, PARAMS)).rejects.toThrow();
    expect(client.inFlight(ENDPOINT)).toBe(0);
  });
});

describe("runTask", () => {
  it("polls until the provider reaches a terminal state", async () => {
    let polls = 0;
    const client = new A2AClient({
      sleep: fakeClock().sleep,
      fetch: async (_url, init) => {
        const body = JSON.parse(String((init as RequestInit).body)) as { method: string };
        if (body.method === "task/create") return rpcOk({ taskId: "t1", state: "WORKING" });
        polls += 1;
        return rpcOk(
          polls < 3
            ? { taskId: "t1", state: TaskState.Working, updatedAt: "now" }
            : { taskId: "t1", state: TaskState.Delivered, deliverable: "0xabc", updatedAt: "now" },
        );
      },
    });
    const result = await client.runTask(ENDPOINT, PARAMS, { pollIntervalMs: 0 });
    expect(result.state).toBe(TaskState.Delivered);
    expect(polls).toBe(3);
  });

  it("returns a failed task rather than throwing", async () => {
    // A provider that could not do the work has answered the question. The
    // caller's next move is the same either way: wait for the evaluator.
    const client = new A2AClient({
      sleep: fakeClock().sleep,
      fetch: async (_url, init) => {
        const body = JSON.parse(String((init as RequestInit).body)) as { method: string };
        return body.method === "task/create"
          ? rpcOk({ taskId: "t1", state: "WORKING" })
          : rpcOk({ taskId: "t1", state: TaskState.Failed, reason: "model refused", updatedAt: "now" });
      },
    });
    const result = await client.runTask(ENDPOINT, PARAMS, { pollIntervalMs: 0 });
    expect(result.state).toBe(TaskState.Failed);
    expect(result.reason).toBe("model refused");
  });

  it("gives up after maxPolls", async () => {
    const client = new A2AClient({
      sleep: fakeClock().sleep,
      fetch: async (_url, init) => {
        const body = JSON.parse(String((init as RequestInit).body)) as { method: string };
        return body.method === "task/create"
          ? rpcOk({ taskId: "t1", state: "WORKING" })
          : rpcOk({ taskId: "t1", state: TaskState.Working, updatedAt: "now" });
      },
    });
    await expect(
      client.runTask(ENDPOINT, PARAMS, { pollIntervalMs: 0, maxPolls: 4 }),
    ).rejects.toThrow(/within 4 polls/);
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    const client = new A2AClient({
      sleep: async () => { controller.abort(); },
      fetch: async (_url, init) => {
        const body = JSON.parse(String((init as RequestInit).body)) as { method: string };
        return body.method === "task/create"
          ? rpcOk({ taskId: "t1", state: "WORKING" })
          : rpcOk({ taskId: "t1", state: TaskState.Working, updatedAt: "now" });
      },
    });
    await expect(
      client.runTask(ENDPOINT, PARAMS, { pollIntervalMs: 0, signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
  });

  it("is an A2AError in every failure mode, so callers can switch on kind", async () => {
    const client = new A2AClient({ sleep: fakeClock().sleep, maxRetries: 1, fetch: async () => jsonResponse({}, 400) });
    await expect(client.createTask(ENDPOINT, PARAMS)).rejects.toBeInstanceOf(A2AError);
  });
});
