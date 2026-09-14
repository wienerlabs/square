import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CapabilityOptions } from "@squaresdk/agent";
import { bridgeTools } from "../src/bridge.js";
import { ToolPool } from "../src/pool.js";
import { startToolServer, type ToolServer } from "./helpers/toolServer.js";

/** What `createAgent` would have been told, without an agent. */
function recorder() {
  const declared = new Map<string, CapabilityOptions>();
  const agent = {
    capability(id: string, options: CapabilityOptions) {
      declared.set(id, options);
      return agent;
    },
  };
  return { agent, declared };
}

const call = (options: CapabilityOptions, input: string) =>
  options.handler({ input, taskId: "t", capability: "c", jobId: "1", callerDid: "did:x", signal: new AbortController().signal });

describe("bridgeTools: an MCP server's tools as an agent's capabilities", () => {
  let weather: ToolServer;
  beforeAll(async () => {
    weather = await startToolServer();
  });
  afterAll(async () => {
    await weather.close();
  });

  it("declares one capability per tool, priced as told, and the handler calls the tool with the input as its arguments", async () => {
    const pool = new ToolPool({ servers: [{ name: "weather", url: weather.url }], cache: false });
    const { agent, declared } = recorder();
    try {
      const bridged = await bridgeTools(agent, pool, {
        price: (tool) => (tool.tool === "forecast" ? "0.10" : undefined),
        include: (tool) => tool.tool !== "slow" && tool.tool !== "big",
      });
      expect(bridged.map((b) => [b.id, b.price])).toEqual([
        ["mcp.weather.forecast", "0.10"],
        ["mcp.weather.boom", undefined],
        ["mcp.weather.structured", undefined],
      ]);
      expect(declared.get("mcp.weather.forecast")).toMatchObject({ description: "Tomorrow's weather in a city.", price: "0.10" });

      const forecast = declared.get("mcp.weather.forecast")!;
      expect(await call(forecast, "Berlin")).toBe("Berlin: sunny");
      expect(await call(forecast, '{"city":"Oslo","days":3}')).toBe("Oslo: sunny for 3 days");
      expect(weather.calls.slice(-2)).toEqual([
        { tool: "forecast", args: { city: "Berlin" } },
        { tool: "forecast", args: { city: "Oslo", days: 3 } },
      ]);
      await expect(call(forecast, "")).rejects.toThrow(/needs city/);
      await expect(call(declared.get("mcp.weather.boom")!, "")).rejects.toThrow("weather__boom tool-error: the teapot is short and stout");
    } finally {
      await pool.close();
    }
  });

  it("refuses two tools that fold to one capability id", async () => {
    // Server names are case-sensitive to the pool and folded by the card's alphabet.
    const pool = new ToolPool({
      servers: [
        { name: "weather", url: weather.url },
        { name: "Weather", url: weather.url },
      ],
      cache: false,
    });
    try {
      await expect(bridgeTools(recorder().agent, pool)).rejects.toThrow(/weather__forecast and Weather__forecast both fold to capability mcp.weather.forecast/);
    } finally {
      await pool.close();
    }
  });
});
