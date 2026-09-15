import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileDutyState } from "../src/node.js";

/** The file the duty keeps its jobs in across restarts (square#348). */
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "square-duty-"));
  dirs.push(dir);
  return join(dir, "nested", "duty.json");
};

describe("fileDutyState", () => {
  it("reads nothing from a file that is not there, and round-trips what it is given", () => {
    const path = fresh();
    const state = fileDutyState(path);
    expect(state.load()).toEqual([]);
    state.save([
      { jobId: 7n, category: "text.summarize", budget: 1_000_000n },
      { jobId: 8n, category: undefined },
    ]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ jobs: [{ jobId: "7", category: "text.summarize", budget: "1000000" }, { jobId: "8" }] });
    expect(fileDutyState(path).load()).toEqual([
      { jobId: 7n, category: "text.summarize", budget: 1_000_000n },
      { jobId: 8n, category: undefined },
    ]);
    // Written whole and renamed into place: no temporary file is left behind.
    expect(readdirSync(join(path, ".."))).toEqual(["duty.json"]);
  });

  it("refuses a file it cannot read as the duty's, naming what is wrong", () => {
    const path = fresh();
    const state = fileDutyState(path);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ jobs: [{ jobId: 7 }] }));
    expect(() => state.load()).toThrow("jobs[0].jobId is not a decimal job id");
    writeFileSync(path, JSON.stringify({ jobs: [{ jobId: "7", budget: "1.5" }] }));
    expect(() => state.load()).toThrow("jobs[0].budget is not a decimal amount");
    writeFileSync(path, JSON.stringify({ tracked: [] }));
    expect(() => state.load()).toThrow("expected { jobs: [...] }");
    expect(existsSync(path)).toBe(true);
  });
});
