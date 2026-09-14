import type Anthropic from "@anthropic-ai/sdk";

/** What the run needs of an Anthropic client: `messages.create`, non-streaming. `new Anthropic()` is one; a test scripts one. */
export interface ModelClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

/** What a tool call produced, for the model. */
export interface ToolOutcome {
  content: string;
  isError?: boolean | undefined;
}

export interface RunOptions {
  client: ModelClient;
  model: string;
  /** The capability's instructions; the system prompt is built from them. */
  instructions: string;
  /** The capability id, named to the model so a multi-capability agent does the one it was paid for. */
  capability: string;
  /** The task's input: the user turn. */
  input: string;
  tools: Anthropic.Tool[];
  execute: (name: string, input: Record<string, unknown>) => Promise<ToolOutcome>;
  /** Most model turns; a run that has not answered by then fails. Default 12. */
  maxTurns?: number | undefined;
  maxTokens?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  ok: boolean;
}

export interface RunOutcome {
  /** The delivered text: every text block of the final turn, joined. */
  text: string;
  turns: number;
  toolCalls: ToolCallRecord[];
  usage: { inputTokens: number; outputTokens: number };
}

export class ModelRunError extends Error {
  constructor(
    message: string,
    readonly reason: "max_tokens" | "refusal" | "context_window" | "turns" | "aborted" | "no_text",
  ) {
    super(message);
    this.name = "ModelRunError";
  }
}

export const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_MAX_TURNS = 12;
const DEFAULT_MAX_TOKENS = 16_000;

/**
 * One capability, run by the model: the instructions as the system prompt,
 * the task's input as the user turn, the tools the model may call, and the
 * loop that calls them until the model answers in text.
 *
 * The text of the final turn is what the agent delivers, and so what the
 * client paid for. A run that ends any other way, cut at `max_tokens`,
 * refused, out of turns, is an error rather than a partial answer: an
 * escrowed job is not delivered against half an output, and the task fails
 * with the reason so the client's escrow returns through the evaluator or
 * expiry.
 *
 * Tool results of one turn go back in one user message, whatever their
 * number; a tool that fails is reported with `is_error` rather than
 * dropped, so the model knows and can say so.
 */
export async function runCapability(options: RunOptions): Promise<RunOutcome> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: options.input }];
  const toolCalls: ToolCallRecord[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const system =
    `You are serving the capability "${options.capability}" of a Square agent. The text of your final answer is delivered, ` +
    `as it is, to the client who paid for this task; do only what this capability describes, and if the input does not fit it, ` +
    `say so plainly instead of doing something else.\n\n${options.instructions}`;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    if (options.signal?.aborted) throw new ModelRunError("the task was aborted", "aborted");
    const response = await options.client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      thinking: { type: "adaptive" },
      system,
      messages,
      ...(options.tools.length > 0 ? { tools: options.tools } : {}),
    });
    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;

    switch (response.stop_reason) {
      case "end_turn":
      case "stop_sequence": {
        const text = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim();
        if (text === "") throw new ModelRunError("the model ended its turn without any text to deliver", "no_text");
        return { text, turns: turn, toolCalls, usage };
      }
      case "pause_turn":
        // A server-side tool paused the turn; the assistant content goes back as it is and the model continues.
        messages.push({ role: "assistant", content: response.content });
        continue;
      case "max_tokens":
        throw new ModelRunError(`the answer was cut at ${options.maxTokens ?? DEFAULT_MAX_TOKENS} tokens`, "max_tokens");
      case "refusal": {
        const category = response.stop_details?.type === "refusal" ? response.stop_details.category : null;
        throw new ModelRunError(`the model declined the task${category ? ` (${category})` : ""}`, "refusal");
      }
      case "model_context_window_exceeded":
        throw new ModelRunError("the task no longer fits the model's context window", "context_window");
      case "tool_use":
        break;
      default:
        throw new ModelRunError(`the model stopped for an unknown reason: ${String(response.stop_reason)}`, "no_text");
    }

    const uses = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of uses) {
      // Tool inputs are parsed JSON already; a model may escape strings differently between versions, which is why they are never string-matched.
      const input = (typeof use.input === "object" && use.input !== null ? use.input : {}) as Record<string, unknown>;
      let outcome: ToolOutcome;
      try {
        outcome = await options.execute(use.name, input);
      } catch (error) {
        outcome = { content: error instanceof Error ? error.message : String(error), isError: true };
      }
      toolCalls.push({ name: use.name, input, ok: !outcome.isError });
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: outcome.content,
        ...(outcome.isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: results });
  }
  throw new ModelRunError(`no answer after ${maxTurns} turns`, "turns");
}
