import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient } from "../../src/model.js";

/** One scripted turn: what the model "says" when asked. */
export type Step =
  | { text: string }
  | { tools: Array<{ name: string; input: Record<string, unknown>; id?: string }>; text?: string }
  | { stop: Anthropic.StopReason; category?: string }
  | ((request: Anthropic.MessageCreateParamsNonStreaming) => Step);

/**
 * A model that answers from a script, one step per call, and keeps every
 * request it was sent. The loop is what is under test; the model's own
 * judgement is not.
 */
export function scriptedModel(steps: Step[]): ModelClient & { requests: Anthropic.MessageCreateParamsNonStreaming[] } {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let counter = 0;
  const message = (partial: Partial<Anthropic.Message>): Anthropic.Message =>
    ({
      id: `msg_${counter}`,
      type: "message",
      role: "assistant",
      model: "scripted",
      content: [],
      stop_reason: "end_turn",
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null } as unknown as Anthropic.Usage,
      ...partial,
    }) as Anthropic.Message;
  return {
    requests,
    messages: {
      async create(params) {
        // The loop appends to one messages array; what was sent is what it held at the time.
        requests.push({ ...params, messages: structuredClone(params.messages) });
        let step = steps[counter];
        counter += 1;
        if (step === undefined) throw new Error(`the script has no step ${counter}`);
        if (typeof step === "function") step = step(params);
        if ("stop" in step) {
          return message({
            stop_reason: step.stop,
            ...(step.stop === "refusal"
              ? { stop_details: { type: "refusal", category: step.category ?? null, explanation: "declined" } as unknown as Anthropic.Message["stop_details"] }
              : {}),
            content: [{ type: "text", text: "", citations: null }],
          });
        }
        if ("tools" in step) {
          return message({
            stop_reason: "tool_use",
            content: [
              ...(step.text ? [{ type: "text" as const, text: step.text, citations: null }] : []),
              ...step.tools.map(
                (t, i) => ({ type: "tool_use", id: t.id ?? `toolu_${counter}_${i}`, name: t.name, input: t.input, caller: { type: "direct" } }) as unknown as Anthropic.ToolUseBlock,
              ),
            ],
          });
        }
        const text = (step as { text: string }).text;
        return message({ content: [{ type: "text", text, citations: null }] });
      },
    },
  };
}
