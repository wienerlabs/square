import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { A2AClient } from "../src/client.js";
import { A2AServer } from "../src/server.js";
import { TaskState } from "../src/states.js";
import { findA2AEndpoint } from "../src/discovery.js";

/**
 * The acceptance criterion, end to end: an agent takes a task and returns a
 * result. A real HTTP server, a real client, real JSON-RPC over the socket.
 *
 * The agent here is as small as an agent can be and still be one. What it
 * returns is a hash of its output rather than the output itself, because
 * ERC-8183's `submit` takes a bytes32 — the deliverable that crosses the wire
 * has to be the same shape as the one that would go on chain.
 */

const CALLER_DID = "did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:892271";

const agent = new A2AServer({
  handlers: {
    "text.summarize": async ({ input }) => {
      const summary = input.split(/\s+/).slice(0, 3).join(" ");
      return `0x${createHash("sha256").update(summary).digest("hex")}`;
    },
    "text.fail": async () => {
      throw new Error("this capability always fails");
    },
    "text.slow": async () => {
      await new Promise((r) => setTimeout(r, 120));
      return "0xslow";
    },
  },
});

let server: Server;
let endpoint: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      void (async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400).end();
          return;
        }
        const response = await agent.handle(parsed);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(response));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  endpoint = `http://127.0.0.1:${address.port}/a2a`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("an agent takes a task and returns a result", () => {
  it("runs the whole handshake over real HTTP", async () => {
    const client = new A2AClient();
    const result = await client.runTask(
      endpoint,
      {
        taskId: "e2e-1",
        capability: "text.summarize",
        input: "stablecoin settlement on Arc for autonomous agents",
        callerDid: CALLER_DID,
        jobId: "42",
      },
      { pollIntervalMs: 20 },
    );

    expect(result.state).toBe(TaskState.Delivered);
    expect(result.deliverable).toMatch(/^0x[0-9a-f]{64}$/);

    // Deterministic: the same input yields the same deliverable, which is what
    // makes a hash usable as an on-chain reference to off-chain work.
    const expected = `0x${createHash("sha256").update("stablecoin settlement on").digest("hex")}`;
    expect(result.deliverable).toBe(expected);
  }, 20_000);

  it("reports a handler that throws as FAILED, with the reason", async () => {
    const client = new A2AClient();
    const result = await client.runTask(
      endpoint,
      { taskId: "e2e-2", capability: "text.fail", input: "x", callerDid: CALLER_DID, jobId: "43" },
      { pollIntervalMs: 20 },
    );
    expect(result.state).toBe(TaskState.Failed);
    expect(result.reason).toBe("this capability always fails");
  }, 20_000);

  it("polls a slow task through WORKING to DELIVERED", async () => {
    const client = new A2AClient();
    const result = await client.runTask(
      endpoint,
      { taskId: "e2e-3", capability: "text.slow", input: "x", callerDid: CALLER_DID, jobId: "44" },
      { pollIntervalMs: 20 },
    );
    expect(result.state).toBe(TaskState.Delivered);
  }, 20_000);

  it("refuses a capability the agent does not offer", async () => {
    const client = new A2AClient();
    await expect(
      client.createTask(endpoint, {
        taskId: "e2e-4",
        capability: "image.generate",
        input: "x",
        callerDid: CALLER_DID,
        jobId: "45",
      }),
    ).rejects.toThrow(/does not offer image.generate/);
  }, 20_000);

  it("refuses a task that is missing a field rather than inventing one", async () => {
    const client = new A2AClient();
    await expect(
      client.createTask(endpoint, {
        taskId: "e2e-5",
        capability: "text.summarize",
        input: "x",
        callerDid: CALLER_DID,
        jobId: "",
      }),
    ).rejects.toThrow(/missing or empty jobId/);
  }, 20_000);

  it("answers task/status for an unknown task instead of inventing a state", async () => {
    const client = new A2AClient();
    await expect(client.taskStatus(endpoint, "never-created")).rejects.toThrow(/no such task/);
  }, 20_000);

  it("does not offer task/cancel, and says so with the caller's own id", async () => {
    // The server accepts inside task/create, so a caller never observes the
    // task SUBMITTED, which is the only state a cancel is allowed from. A
    // method that could only ever answer with an error is not on the wire.
    // The id is numeric on purpose: JSON-RPC 2.0 allows it, and a caller with
    // several requests in flight needs it back untouched.
    const client = new A2AClient();
    await client.createTask(endpoint, {
      taskId: "e2e-6",
      capability: "text.slow",
      input: "x",
      callerDid: CALLER_DID,
      jobId: "46",
    });
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "task/cancel", params: { taskId: "e2e-6" } }),
    });
    const body = (await res.json()) as { id: unknown; error?: { code: number; message: string } };
    expect(body.error?.code).toBe(-32601);
    expect(body.error?.message).toMatch(/unknown method: task\/cancel/);
    expect(body.id).toBe(42);
  }, 20_000);

  it("answers a retried task/create with the task as it stands, over the socket", async () => {
    // The retry a client sends after a lost response: same taskId, same
    // fields. It is not an error, and it does not start the work twice.
    const client = new A2AClient();
    const params = { taskId: "e2e-8", capability: "text.summarize", input: "one two three four", callerDid: CALLER_DID, jobId: "48" };
    const first = await client.createTask(endpoint, params);
    expect(first.state).toBe(TaskState.Working);
    await new Promise((r) => setTimeout(r, 50));
    const again = await client.createTask(endpoint, params);
    expect(again.taskId).toBe("e2e-8");
    expect(again.state).toBe(TaskState.Delivered);
    expect(agent.machine.list().filter((t) => t.id === "e2e-8")).toHaveLength(1);

    await expect(client.createTask(endpoint, { ...params, input: "different" })).rejects.toThrow(/already in use/);
  }, 20_000);

  it("finds the endpoint from an agent card the way a caller would", () => {
    // The card shape is docs/agent-card/schema.json; the caller reads the A2A
    // service out of it rather than being handed a URL.
    expect(
      findA2AEndpoint({
        services: [
          { name: "MCP", endpoint: "https://agent.example/mcp" },
          { name: "A2A", endpoint: "https://agent.example/a2a", version: "0.3.0" },
        ],
      }),
    ).toBe("https://agent.example/a2a");
  });

  it("leaves the job untouched: the agent never reports anything but its own work", async () => {
    // The whole point. The provider's terminal state is DELIVERED, and there is
    // no field in the response through which it could claim payment.
    const client = new A2AClient();
    const result = await client.runTask(
      endpoint,
      { taskId: "e2e-7", capability: "text.summarize", input: "one two three four", callerDid: CALLER_DID, jobId: "47" },
      { pollIntervalMs: 20 },
    );
    expect(Object.keys(result).sort()).toEqual(["deliverable", "state", "taskId", "updatedAt"]);
    expect(result.state).not.toBe("COMPLETED");
  }, 20_000);
});
