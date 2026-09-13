import { describe, expect, it } from "vitest";
import { ArgumentError, argumentsFor, capabilityIdFor, describeTool, toolsForAnthropic, toolsForGemini, toolsForOpenAI } from "../src/convert.js";
import type { McpTool } from "../src/types.js";

const forecast: McpTool = {
  name: "weather__forecast",
  server: "weather",
  tool: "forecast",
  description: "Tomorrow's weather.",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" }, days: { type: "number" } },
    required: ["city"],
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#",
  },
};

describe("the model tool formats", () => {
  it("carry the qualified name, the description and the schema without the SDK's $schema header", () => {
    expect(toolsForAnthropic([forecast])).toEqual([
      {
        name: "weather__forecast",
        description: "Tomorrow's weather.",
        input_schema: { type: "object", properties: forecast.inputSchema.properties, required: ["city"], additionalProperties: false },
      },
    ]);
    expect(toolsForOpenAI([forecast])[0]).toMatchObject({ type: "function", function: { name: "weather__forecast", parameters: { required: ["city"] } } });
    expect(JSON.stringify(toolsForOpenAI([forecast]))).not.toContain("$schema");
  });

  it("strip additionalProperties for Gemini, at every depth", () => {
    const nested: McpTool = { ...forecast, inputSchema: { type: "object", properties: { a: { type: "object", additionalProperties: false, properties: {} } }, additionalProperties: false } };
    const gemini = toolsForGemini([nested]);
    expect(JSON.stringify(gemini)).not.toContain("additionalProperties");
    expect(gemini.functionDeclarations[0]?.parameters).toEqual({ type: "object", properties: { a: { type: "object", properties: {} } } });
  });

  it("cut a description at 1024 characters and name the tool when there is none", () => {
    expect(describeTool({ ...forecast, description: "x".repeat(2000) })).toHaveLength(1024);
    expect(describeTool({ ...forecast, description: "  " })).toBe("forecast on weather");
  });
});

describe("argumentsFor: the task's one string into the tool's arguments", () => {
  it("takes a JSON object as the arguments themselves", () => {
    expect(argumentsFor(forecast, ' {"city":"Berlin","days":3} ')).toEqual({ city: "Berlin", days: 3 });
  });

  it("takes plain text as the one string the tool needs", () => {
    expect(argumentsFor(forecast, "Berlin")).toEqual({ city: "Berlin" });
    const single: McpTool = { ...forecast, inputSchema: { type: "object", properties: { q: { type: "string" } } } };
    expect(argumentsFor(single, "hello")).toEqual({ q: "hello" });
  });

  it("refuses what it cannot know", () => {
    expect(() => argumentsFor(forecast, "{city")).toThrow(ArgumentError);
    expect(argumentsFor(forecast, "[urgent] Berlin")).toEqual({ city: "[urgent] Berlin" });
    expect(() => argumentsFor(forecast, "")).toThrow(/needs city/);
    const two: McpTool = { ...forecast, inputSchema: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"] } };
    expect(() => argumentsFor(two, "x")).toThrow(/takes a, b \(required: a, b\); pass them as a JSON object/);
    const none: McpTool = { ...forecast, inputSchema: { type: "object" } };
    expect(argumentsFor(none, "")).toEqual({});
    expect(() => argumentsFor(none, "x")).toThrow(/takes no arguments/);
    const numeric: McpTool = { ...forecast, inputSchema: { type: "object", properties: { n: { type: "number" } } } };
    expect(() => argumentsFor(numeric, "5")).toThrow(/pass them as a JSON object/);
  });
});

describe("capabilityIdFor", () => {
  it("folds server and tool into the card's dotted lowercase", () => {
    expect(capabilityIdFor({ server: "weather", tool: "get_forecast" })).toBe("mcp.weather.get.forecast");
    expect(capabilityIdFor({ server: "My-Server", tool: "Search--Docs" }, "tools")).toBe("tools.my.server.search.docs");
  });

  it("refuses an id the card would refuse", () => {
    expect(() => capabilityIdFor({ server: "weather", tool: "x".repeat(70) })).toThrow(/no capability id/);
    expect(() => capabilityIdFor({ server: "weather", tool: "forecast" }, "")).not.toThrow();
    expect(capabilityIdFor({ server: "weather", tool: "forecast" }, "")).toBe("weather.forecast");
  });
});
