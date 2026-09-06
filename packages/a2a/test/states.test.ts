import { describe, it, expect } from "vitest";
import {
  EVALUATOR_ONLY_JOB_ACTIONS,
  JOB_STATUS_NAMES,
  JobStatus,
  PROVIDER_JOB_ACTIONS,
  STATE_MAPPING,
  TaskState,
  expectedJobStatus,
  isTerminalJobStatus,
  isTerminalTaskState,
  providerMayCall,
} from "../src/states.js";

describe("the two state machines are not the same machine", () => {
  it("A2A DELIVERED maps onto ERC-8183 Submitted, never Completed", () => {
    // The naming collision this whole module exists for. A2A's terminal success
    // state means "I delivered"; the chain's Completed means "the escrow paid
    // out". Reading one as the other is how a provider pays itself.
    const row = STATE_MAPPING.find((m) => m.task === TaskState.Delivered)!;
    expect(row.providerAction).toBe("submit");
    expect(row.expects).toBe(JobStatus.Funded);
    expect(row.expects).not.toBe(JobStatus.Completed);
  });

  it("gives the provider exactly one on-chain action across every task state", () => {
    const actions = STATE_MAPPING.map((m) => m.providerAction).filter((a) => a !== null);
    expect(actions).toEqual(["submit"]);
  });

  it("never lets a provider call an evaluator-only action, in any state", () => {
    for (const state of Object.values(TaskState)) {
      for (const action of EVALUATOR_ONLY_JOB_ACTIONS) {
        expect(providerMayCall(state, action)).toBe(false);
      }
    }
  });

  it("permits submit only from DELIVERED", () => {
    for (const state of Object.values(TaskState)) {
      expect(providerMayCall(state, "submit")).toBe(state === TaskState.Delivered);
    }
  });

  it("does not let a provider fund, set a budget or claim a refund mid-task", () => {
    for (const state of Object.values(TaskState)) {
      for (const action of ["fund", "setBudget", "claimRefund"] as const) {
        expect(providerMayCall(state, action)).toBe(false);
      }
    }
  });

  it("expects the job to still be Funded in every task state", () => {
    // Nothing the provider says over HTTP moves the escrow, so every task state
    // sits against a Funded job. The day this stops being true, some task state
    // has acquired the power to settle.
    for (const state of Object.values(TaskState)) {
      expect(expectedJobStatus(state)).toBe(JobStatus.Funded);
    }
  });

  it("has a mapping row for every task state and no orphans", () => {
    const mapped = STATE_MAPPING.map((m) => m.task).sort();
    expect(mapped).toEqual(Object.values(TaskState).sort());
  });

  it("says why in every row", () => {
    // A table of enums teaches nobody why the provider cannot complete.
    for (const row of STATE_MAPPING) {
      expect(row.note.length).toBeGreaterThan(40);
    }
  });
});

describe("job status", () => {
  it("uses the contract's enum ordering", () => {
    // Verified against the deployed registry rather than the ERC: sampling the
    // first forty jobs on Arc Testnet returns 0, 1 and 3 and nothing else,
    // which is Open, Funded and Completed under this ordering.
    expect(JobStatus.Open).toBe(0);
    expect(JobStatus.Funded).toBe(1);
    expect(JobStatus.Submitted).toBe(2);
    expect(JobStatus.Completed).toBe(3);
    expect(JobStatus.Rejected).toBe(4);
    expect(JobStatus.Expired).toBe(5);
  });

  it("names every status", () => {
    for (const value of Object.values(JobStatus)) {
      expect(JOB_STATUS_NAMES[value]).toBeTruthy();
    }
  });

  it("treats Completed, Rejected and Expired as terminal and nothing else", () => {
    expect(isTerminalJobStatus(JobStatus.Completed)).toBe(true);
    expect(isTerminalJobStatus(JobStatus.Rejected)).toBe(true);
    expect(isTerminalJobStatus(JobStatus.Expired)).toBe(true);
    expect(isTerminalJobStatus(JobStatus.Open)).toBe(false);
    expect(isTerminalJobStatus(JobStatus.Funded)).toBe(false);
    expect(isTerminalJobStatus(JobStatus.Submitted)).toBe(false);
  });

  it("treats DELIVERED, FAILED and CANCELLED as terminal task states", () => {
    expect(isTerminalTaskState(TaskState.Delivered)).toBe(true);
    expect(isTerminalTaskState(TaskState.Failed)).toBe(true);
    expect(isTerminalTaskState(TaskState.Cancelled)).toBe(true);
    expect(isTerminalTaskState(TaskState.Submitted)).toBe(false);
    expect(isTerminalTaskState(TaskState.Working)).toBe(false);
  });

  it("keeps submit out of the evaluator's list and complete out of the provider's", () => {
    expect(PROVIDER_JOB_ACTIONS).not.toContain("complete");
    expect(PROVIDER_JOB_ACTIONS).not.toContain("reject");
    expect(EVALUATOR_ONLY_JOB_ACTIONS).not.toContain("submit");
  });
});
