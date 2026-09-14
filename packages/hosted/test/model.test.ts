import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ModelRunError, runCapability, type RunOptions } from "../src/model.js";
import { scriptedModel, type Step } from "./helpers/scriptedModel.js";

const weather: Anthropic.Tool = {
  name: "weather__forecast",
  description: "Tomorrow's weather.",
  input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};

function run(steps: Step[], overrides: Partial<RunOptions> = {}) {
  const model = scriptedModel(steps);
  const executed: Array<[string, Record<string, unknown>]> = [];
  const promise = runCapability({
    client: model,
    model: "claude-opus-5",
    instructions: "Write one sentence about the weather.",
    capability: "weather.brief",
    input: "Berlin tomorrow",
    tools: [weather],
    execute: async (name, input) => {
      executed.push([name, input]);
      if (name === "weather__boom") throw new Error("the teapot is short and stout");
      if (name === "weather__fail") return { content: "no such city", isError: true };
      return { content: `${String(input["city"])}: sunny` };
    },
    ...overrides,
  });
  return { model, executed, promise };
}

describe("runCapability", () => {
  it("asks once, with the instructions, the capability and the tools, and delivers the text", async () => {
    const { model, promise } = run([{ text: "Sunny in Berlin." }]);
    const outcome = await promise;
    expect(outcome).toEqual({ text: "Sunny in Berlin.", turns: 1, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } });
    const request = model.requests[0]!;
    expect(request.model).toBe("claude-opus-5");
    expect(request.max_tokens).toBe(16_000);
    expect(request.thinking).toEqual({ type: "adaptive" });
    expect(request.system).toContain('the capability "weather.brief"');
    expect(request.system).toContain("Write one sentence about the weather.");
    expect(request.tools).toEqual([weather]);
    expect(request.messages).toEqual([{ role: "user", content: "Berlin tomorrow" }]);
  });

  it("runs the tools of a turn, all of them, and hands every result back in one user message", async () => {
    const { model, executed, promise } = run([
      { tools: [{ name: "weather__forecast", input: { city: "Berlin" }, id: "a" }, { name: "weather__fail", input: { city: "Atlantis" }, id: "b" }, { name: "weather__boom", input: {}, id: "c" }], text: "Checking." },
      { text: "Sunny in Berlin; Atlantis is not a city." },
    ]);
    const outcome = await promise;
    expect(executed).toEqual([
      ["weather__forecast", { city: "Berlin" }],
      ["weather__fail", { city: "Atlantis" }],
      ["weather__boom", {}],
    ]);
    expect(outcome.toolCalls).toEqual([
      { name: "weather__forecast", input: { city: "Berlin" }, ok: true },
      { name: "weather__fail", input: { city: "Atlantis" }, ok: false },
      { name: "weather__boom", input: {}, ok: false },
    ]);
    expect(outcome.turns).toBe(2);
    expect(outcome.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    const second = model.requests[1]!;
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1]).toMatchObject({ role: "assistant" });
    expect(second.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: "Berlin: sunny" },
        { type: "tool_result", tool_use_id: "b", content: "no such city", is_error: true },
        { type: "tool_result", tool_use_id: "c", content: "the teapot is short and stout", is_error: true },
      ],
    });
  });

  it("continues through a paused turn", async () => {
    const { model, promise } = run([{ stop: "pause_turn" }, { text: "Done." }]);
    expect((await promise).text).toBe("Done.");
    expect(model.requests[1]!.messages).toHaveLength(2);
  });

  it("fails the run rather than deliver a partial or absent answer", async () => {
    await expect(run([{ stop: "max_tokens" }]).promise).rejects.toThrow(ModelRunError);
    await expect(run([{ stop: "max_tokens" }]).promise).rejects.toMatchObject({ reason: "max_tokens" });
    await expect(run([{ stop: "refusal", category: "cyber" }]).promise).rejects.toMatchObject({ reason: "refusal", message: "the model declined the task (cyber)" });
    await expect(run([{ stop: "model_context_window_exceeded" }]).promise).rejects.toMatchObject({ reason: "context_window" });
    await expect(run([{ text: "   " }]).promise).rejects.toMatchObject({ reason: "no_text" });
    const endless: Step = { tools: [{ name: "weather__forecast", input: { city: "Berlin" } }] };
    await expect(run([endless, endless, endless], { maxTurns: 2 }).promise).rejects.toMatchObject({ reason: "turns", message: "no answer after 2 turns" });
    const aborted = new AbortController();
    aborted.abort();
    await expect(run([{ text: "x" }], { signal: aborted.signal }).promise).rejects.toMatchObject({ reason: "aborted" });
  });

  it("sends no tools field when there are no tools", async () => {
    const { model, promise } = run([{ text: "ok" }], { tools: [] });
    await promise;
    expect("tools" in model.requests[0]!).toBe(false);
  });
});
