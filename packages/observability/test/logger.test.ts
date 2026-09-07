import { describe, it, expect, vi } from "vitest";
import {
  createLogger,
  redact,
  DEFAULT_ALLOWLIST,
  RESERVED_KEYS,
  MAX_STRING_LENGTH,
  type LoggerOptions,
} from "../src/logger.js";

interface Captured {
  lines: string[];
  sink: (line: string) => void;
  parsed(): Array<Record<string, unknown>>;
}

function capture(): Captured {
  const lines: string[] = [];
  return {
    lines,
    sink: (line) => {
      lines.push(line);
    },
    parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const FIXED_NOW = 1_700_000_000_000;
const FIXED_TS = "2023-11-14T22:13:20.000Z";

function build(extra: Partial<LoggerOptions> = {}) {
  const captured = capture();
  const log = createLogger({
    service: "test-service",
    version: "9.9.9",
    clock: () => FIXED_NOW,
    sink: captured.sink,
    ...extra,
  });
  return { captured, log };
}

const PRIVATE_POLICY = {
  max_per_tx: 500000,
  max_daily: 2000000,
  blocked_addresses: ["0xdead000000000000000000000000000000000001", "0xdead000000000000000000000000000000000002"],
  token_whitelist: ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
  allowed_categories: [3, 7, 11],
  time_days_bitmask: 62,
  policy: { max_per_tx: 500000, operator_window: [9, 17] },
  body: { amount: 123456, recipient: "0xbeef000000000000000000000000000000000001" },
  input: { policy_secret: "s3cr3t-policy-value", nonce: 4242 },
};

const PRIVATE_VALUES = [
  "500000",
  "2000000",
  "0xdead",
  "0xa0b86991",
  "[3,7,11]",
  ":62",
  "operator_window",
  "123456",
  "0xbeef",
  "s3cr3t",
  "4242",
];

describe("redaction allowlist", () => {
  it("never lets private policy keys or values reach a line", () => {
    const { captured, log } = build();
    log.info("compliance_violation", { jobId: "job-77", rule: "per_tx_ceiling", ...PRIVATE_POLICY });

    expect(captured.lines).toHaveLength(1);
    const line = captured.lines[0] ?? "";
    for (const key of Object.keys(PRIVATE_POLICY)) expect(line).not.toContain(key);
    for (const value of PRIVATE_VALUES) expect(line).not.toContain(value);

    const [parsed] = captured.parsed();
    expect(parsed).toEqual({
      ts: FIXED_TS,
      level: "info",
      service: "test-service",
      version: "9.9.9",
      event: "compliance_violation",
      jobId: "job-77",
      rule: "per_tx_ceiling",
      dropped_fields: Object.keys(PRIVATE_POLICY).length,
    });
  });

  it("drops private keys nested under allowed keys, recursively", () => {
    const { captured, log } = build();
    log.info("finalized", {
      outcome: {
        status: "ok",
        txHash: "0xabc",
        count: 2,
        policy: { max_daily: 1 },
        error: { reason: "none", body: { amount: 5 }, input: { max_per_tx: 9 } },
      },
    });
    const line = captured.lines[0] ?? "";
    for (const needle of ["policy", "max_daily", "body", "amount", "input", "max_per_tx"]) {
      expect(line).not.toContain(needle);
    }
    const [parsed] = captured.parsed();
    expect(parsed?.outcome).toEqual({ status: "ok", txHash: "0xabc", count: 2, error: { reason: "none" } });
    expect(parsed?.dropped_fields).toBe(3);
  });

  it("filters arrays element by element and keeps primitive arrays", () => {
    const { captured, log } = build();
    log.info("batch", {
      count: [1, 2, 3],
      outcome: [{ status: "ok", policy: { x: 1 } }, "plain", null],
      blocked_addresses: ["0xdead"],
    });
    const [parsed] = captured.parsed();
    expect(parsed?.count).toEqual([1, 2, 3]);
    expect(parsed?.outcome).toEqual([{ status: "ok" }, "plain", null]);
    expect(parsed?.blocked_addresses).toBeUndefined();
    expect(parsed?.dropped_fields).toBe(2);
  });

  it("merges a caller allowlist with the built-in safe set", () => {
    const { captured, log } = build({ allowlist: ["component"] });
    for (const key of DEFAULT_ALLOWLIST) expect(log.allowlist.has(key)).toBe(true);
    expect(log.allowlist.has("component")).toBe(true);
    log.info("tick", { component: "finalizer", jobId: "j1", secret: "no" });
    const [parsed] = captured.parsed();
    expect(parsed?.component).toBe("finalizer");
    expect(parsed?.jobId).toBe("j1");
    expect(parsed?.secret).toBeUndefined();
    expect(parsed?.dropped_fields).toBe(1);
  });

  it("does not let fields override the reserved line keys", () => {
    const { captured, log } = build({ allowlist: [...RESERVED_KEYS] });
    log.info("tick", { level: "debug", ts: "1999", service: "other", version: "0", event: "fake", jobId: "j" });
    const [parsed] = captured.parsed();
    expect(parsed?.level).toBe("info");
    expect(parsed?.ts).toBe(FIXED_TS);
    expect(parsed?.service).toBe("test-service");
    expect(parsed?.version).toBe("9.9.9");
    expect(parsed?.event).toBe("tick");
    expect(parsed?.dropped_fields).toBe(5);
  });

  it("omits dropped_fields when nothing was dropped", () => {
    const { captured, log } = build();
    log.info("tick", { jobId: "j" });
    const [parsed] = captured.parsed();
    expect(parsed).not.toHaveProperty("dropped_fields");
  });

  it("is available as a pure function", () => {
    expect(redact({ jobId: "a", max_per_tx: 1 })).toEqual({ fields: { jobId: "a" }, dropped: 1 });
    expect(redact({ component: "x" }, { allowlist: ["component"] })).toEqual({ fields: { component: "x" }, dropped: 0 });
  });
});

describe("value handling", () => {
  it("truncates long strings and marks the containing object", () => {
    const { captured, log } = build();
    const long = "x".repeat(MAX_STRING_LENGTH + 500);
    log.error("boom", { error: long, outcome: { reason: long, status: "ok" }, jobId: "short" });
    const [parsed] = captured.parsed();
    expect((parsed?.error as string).length).toBe(MAX_STRING_LENGTH);
    expect(parsed?.truncated).toBe(true);
    const outcome = parsed?.outcome as Record<string, unknown>;
    expect((outcome.reason as string).length).toBe(MAX_STRING_LENGTH);
    expect(outcome.truncated).toBe(true);
    expect(outcome.status).toBe("ok");
  });

  it("does not mark short strings as truncated", () => {
    const { captured, log } = build();
    log.info("ok", { error: "short" });
    const [parsed] = captured.parsed();
    expect(parsed).not.toHaveProperty("truncated");
  });

  it("serialises Error instances as name, message and stack only", () => {
    const { captured, log } = build();
    const error = Object.assign(new Error("witness generation failed"), {
      policy: { max_per_tx: 1 },
      body: "0xdead",
    });
    log.error("proof_failed", { error });
    const line = captured.lines[0] ?? "";
    expect(line).not.toContain("policy");
    expect(line).not.toContain("0xdead");
    const [parsed] = captured.parsed();
    const serialised = parsed?.error as Record<string, unknown>;
    expect(serialised.name).toBe("Error");
    expect(serialised.message).toBe("witness generation failed");
    expect(typeof serialised.stack).toBe("string");
    expect(Object.keys(serialised).sort()).toEqual(["message", "name", "stack"]);
  });

  it("converts bigint and Date values", () => {
    const { captured, log } = build();
    log.info("block", { blockNumber: 1234567n, age: new Date(FIXED_NOW), gasUsed: 2n ** 64n });
    const [parsed] = captured.parsed();
    expect(parsed?.blockNumber).toBe(1234567);
    expect(parsed?.age).toBe(FIXED_TS);
    expect(parsed?.gasUsed).toBe((2n ** 64n).toString());
  });

  it("survives cyclic and very deep structures", () => {
    const { captured, log } = build();
    const cyclic: Record<string, unknown> = { jobId: "cycle" };
    cyclic.outcome = cyclic;
    expect(() => log.info("cyclic", cyclic)).not.toThrow();
    let deep: Record<string, unknown> = { status: "leaf" };
    for (let i = 0; i < 20; i += 1) deep = { outcome: deep };
    expect(() => log.info("deep", deep)).not.toThrow();
    expect(captured.lines).toHaveLength(2);
    for (const line of captured.lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("drops functions and symbols, ignores undefined", () => {
    const { captured, log } = build();
    log.info("mixed", { jobId: undefined, reason: () => "x", status: Symbol("s"), count: 1 });
    const [parsed] = captured.parsed();
    expect(parsed?.count).toBe(1);
    expect(parsed?.dropped_fields).toBe(2);
    expect(parsed).not.toHaveProperty("jobId");
  });
});

describe("line shape and levels", () => {
  it("writes exactly one valid JSON line per call with the standard head", () => {
    const { captured, log } = build();
    log.info("a");
    log.warn("b", { jobId: "1" });
    log.error("c", { count: 3 });
    expect(captured.lines).toHaveLength(3);
    const parsed = captured.parsed();
    expect(parsed.map((p) => p.event)).toEqual(["a", "b", "c"]);
    expect(parsed.map((p) => p.level)).toEqual(["info", "warn", "error"]);
    for (const line of parsed) {
      expect(line.ts).toBe(FIXED_TS);
      expect(line.service).toBe("test-service");
      expect(line.version).toBe("9.9.9");
    }
    for (const line of captured.lines) expect(line).not.toContain("\n");
  });

  it("filters below the configured level", () => {
    const { captured, log } = build({ level: "warn" });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(captured.parsed().map((p) => p.event)).toEqual(["w", "e"]);
  });

  it("defaults to info, so debug is silent", () => {
    const { captured, log } = build();
    log.debug("d");
    log.info("i");
    expect(captured.parsed().map((p) => p.event)).toEqual(["i"]);
  });

  it("carries child bindings through the same allowlist", () => {
    const { captured, log } = build();
    const child = log.child({ jobId: "job-1", component: "keeper" });
    child.info("tick", { attempt: 2 });
    const grandchild = child.child({ chainId: 5042002 });
    grandchild.warn("retry");
    const [first, second] = captured.parsed();
    expect(first).toMatchObject({ jobId: "job-1", attempt: 2, dropped_fields: 1 });
    expect(first).not.toHaveProperty("component");
    expect(second).toMatchObject({ jobId: "job-1", chainId: 5042002, dropped_fields: 1 });
    expect(captured.lines.join("")).not.toContain("component");
  });

  it("writes to stdout by default", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const log = createLogger({ service: "s", version: "1" });
      log.info("hello", { jobId: "j" });
      expect(write).toHaveBeenCalledTimes(1);
      const [chunk] = write.mock.calls[0] ?? [];
      expect(String(chunk).endsWith("\n")).toBe(true);
      expect(JSON.parse(String(chunk).trim())).toMatchObject({ event: "hello", jobId: "j" });
    } finally {
      write.mockRestore();
    }
  });

  it("never throws when the sink throws", () => {
    const log = createLogger({
      service: "s",
      version: "1",
      sink: () => {
        throw new Error("EPIPE");
      },
    });
    expect(() => log.info("x")).not.toThrow();
  });
});
