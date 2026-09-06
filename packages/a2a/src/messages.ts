import { TaskState } from "./states.js";

/**
 * The wire format: JSON-RPC 2.0 over HTTP POST.
 *
 * One thing is deliberately absent. The predecessor's `task/create` carried
 * `paymentRef` and `amount` — the escrow transaction hash and the price — so a
 * provider could read what it was owed out of the request that asked it to
 * work. Money is the client's and the evaluator's business, and a provider that
 * cannot see the amount cannot condition its behaviour on it.
 *
 * `jobId` is here instead. It identifies which escrow the work belongs to, which
 * the provider genuinely needs in order to call `submit`, and it reveals
 * nothing a public chain does not already publish.
 */

export interface JsonRpcRequest<P = Record<string, unknown>> {
  jsonrpc: "2.0";
  method: string;
  params: P;
  id: string;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse<R = unknown> {
  jsonrpc: "2.0";
  result?: R;
  error?: JsonRpcError;
  id: string;
}

/** JSON-RPC 2.0 reserved codes, plus the ones this protocol adds. */
export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** The provider does not offer the requested capability. */
  CapabilityNotOffered: -32000,
  /** The provider is at its concurrency limit. Retryable. */
  Busy: -32001,
  /** No such task at this provider. */
  TaskNotFound: -32002,
} as const;

export type RpcErrorCode = (typeof RpcErrorCode)[keyof typeof RpcErrorCode];

export const TASK_METHODS = ["task/create", "task/status", "task/cancel"] as const;
export type TaskMethod = (typeof TASK_METHODS)[number];

export interface TaskCreateParams {
  /** Caller-chosen id. The provider echoes it so both sides name the task the same thing. */
  taskId: string;
  /** Capability id from the agent card, e.g. `text.summarize`. */
  capability: string;
  /** The work itself. */
  input: string;
  /** did:aip of the caller. */
  callerDid: string;
  /** ERC-8183 job this task belongs to, so the provider knows what to `submit` against. */
  jobId: string;
}

export interface TaskCreateResult {
  taskId: string;
  state: typeof TaskState.Working;
  acceptedAt: string;
}

export interface TaskStatusParams {
  taskId: string;
}

export interface TaskStatusResult {
  taskId: string;
  state: TaskState;
  /**
   * Present when state is DELIVERED. A reference to the work, not the work:
   * ERC-8183's `submit` takes a bytes32, so what goes on chain is a hash or a
   * CID, and keeping the same shape here stops the two from drifting.
   */
  deliverable?: string;
  /** Present when state is FAILED. */
  reason?: string;
  updatedAt: string;
}

export interface TaskCancelParams {
  taskId: string;
}

export interface TaskCancelResult {
  taskId: string;
  state: typeof TaskState.Cancelled;
}

let counter = 0;

/** Ids are unique per process and monotonic, which is all JSON-RPC asks of them. */
export function nextRpcId(): string {
  counter += 1;
  return `rpc_${counter}_${Date.now()}`;
}

export function rpcRequest<P extends Record<string, unknown>>(
  method: TaskMethod,
  params: P,
): JsonRpcRequest<P> {
  return { jsonrpc: "2.0", method, params, id: nextRpcId() };
}

export function rpcResult<R>(id: string, result: R): JsonRpcResponse<R> {
  return { jsonrpc: "2.0", result, id };
}

export function rpcError(id: string, code: number, message: string, data?: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    error: { code, message, ...(data !== undefined ? { data } : {}) },
    id,
  };
}

/**
 * Is this a JSON-RPC 2.0 response at all?
 *
 * A provider that is down often answers with an HTML error page and a 200, and
 * `data.result` on a parsed HTML string is `undefined` rather than a throw. The
 * check is here so that failure surfaces as "not a JSON-RPC response" instead
 * of as a task that silently never progresses.
 */
export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.jsonrpc !== "2.0") return false;
  if (typeof v.id !== "string") return false;
  return "result" in v || "error" in v;
}
