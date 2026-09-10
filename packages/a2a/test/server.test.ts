import { describe, it, expect } from "vitest";
import { TASK_METHODS, isJsonRpcResponse } from "../src/messages.js";
import { A2AServer } from "../src/server.js";

/**
 * The handler on its own, without a socket: what it does with the envelope
 * around a request, as opposed to the task inside it.
 */

const server = new A2AServer({ handlers: { "text.echo": async ({ input }) => input } });

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
