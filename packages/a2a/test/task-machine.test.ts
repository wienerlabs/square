import { describe, it, expect } from "vitest";
import { TaskState } from "../src/states.js";
import { TaskMachine, TaskTransitionError } from "../src/task-machine.js";

const base = {
  id: "t1",
  capability: "text.summarize",
  input: "a document",
  callerDid: "did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:892271",
  jobId: "42",
};

function machineWithTask(): TaskMachine {
  const m = new TaskMachine();
  m.create(base);
  return m;
}

describe("TaskMachine", () => {
  it("starts a task SUBMITTED", () => {
    expect(machineWithTask().get("t1")!.state).toBe(TaskState.Submitted);
  });

  it("refuses a duplicate id rather than overwriting the first task", () => {
    const m = machineWithTask();
    expect(() => m.create(base)).toThrow(TaskTransitionError);
    expect(m.list()).toHaveLength(1);
  });

  it("runs the ordinary path", () => {
    const m = machineWithTask();
    expect(m.accept("t1").state).toBe(TaskState.Working);
    const done = m.deliver("t1", "0xabc");
    expect(done.state).toBe(TaskState.Delivered);
    expect(done.deliverable).toBe("0xabc");
  });

  it("carries a reason on failure", () => {
    const m = machineWithTask();
    m.accept("t1");
    expect(m.fail("t1", "model refused").reason).toBe("model refused");
  });

  it("lets a task fail before it was ever accepted", () => {
    expect(machineWithTask().fail("t1", "no capacity").state).toBe(TaskState.Failed);
  });

  it("will not deliver work that was never accepted", () => {
    expect(() => machineWithTask().deliver("t1", "0xabc")).toThrow(/cannot deliver/);
  });

  it("will not deliver an empty deliverable", () => {
    const m = machineWithTask();
    m.accept("t1");
    expect(() => m.deliver("t1", "")).toThrow(/empty deliverable/);
  });

  it("will not deliver twice", () => {
    const m = machineWithTask();
    m.accept("t1");
    m.deliver("t1", "0xabc");
    expect(() => m.deliver("t1", "0xdef")).toThrow(/cannot deliver/);
  });

  it("will not fail a task that already delivered", () => {
    // Otherwise a slow error path could overwrite a delivery the caller has
    // already seen and may already have submitted on chain.
    const m = machineWithTask();
    m.accept("t1");
    m.deliver("t1", "0xabc");
    expect(() => m.fail("t1", "late error")).toThrow(/cannot fail/);
  });

  it("cancels only before acknowledgement", () => {
    const m = machineWithTask();
    expect(m.cancel("t1").state).toBe(TaskState.Cancelled);

    const m2 = machineWithTask();
    m2.accept("t1");
    // The work may already be done and the escrow settles through the
    // evaluator regardless, so a caller cannot take it back by saying so.
    expect(() => m2.cancel("t1")).toThrow(/cannot cancel/);
  });

  it("reports the state it refused from", () => {
    const m = machineWithTask();
    m.accept("t1");
    try {
      m.cancel("t1");
      expect.unreachable();
    } catch (err) {
      expect((err as TaskTransitionError).from).toBe(TaskState.Working);
      expect((err as TaskTransitionError).attempted).toBe("cancel");
    }
  });

  it("names an unknown task instead of silently doing nothing", () => {
    expect(() => new TaskMachine().accept("nope")).toThrow(/no such task/);
  });

  it("notifies subscribers of every transition, with the previous state", () => {
    const m = machineWithTask();
    const seen: string[] = [];
    m.subscribe((task, previous) => seen.push(`${previous}->${task.state}`));
    m.accept("t1");
    m.deliver("t1", "0xabc");
    expect(seen).toEqual(["SUBMITTED->WORKING", "WORKING->DELIVERED"]);
  });

  it("does not let a throwing subscriber break a transition", () => {
    const m = machineWithTask();
    m.subscribe(() => {
      throw new Error("subscriber is broken");
    });
    expect(() => m.accept("t1")).not.toThrow();
    expect(m.get("t1")!.state).toBe(TaskState.Working);
  });

  it("stops notifying after unsubscribe", () => {
    const m = machineWithTask();
    let count = 0;
    const off = m.subscribe(() => { count += 1; });
    m.accept("t1");
    off();
    m.deliver("t1", "0xabc");
    expect(count).toBe(1);
  });

  it("sweeps terminal tasks and keeps live ones", () => {
    const m = new TaskMachine();
    m.create({ ...base, id: "done" });
    m.accept("done");
    m.deliver("done", "0xabc");
    m.create({ ...base, id: "live" });

    expect(m.sweep(new Date(Date.now() + 1000))).toBe(1);
    expect(m.get("done")).toBeNull();
    expect(m.get("live")).not.toBeNull();
  });

  it("does not sweep a terminal task that is still recent", () => {
    const m = machineWithTask();
    m.cancel("t1");
    expect(m.sweep(new Date(Date.now() - 60_000))).toBe(0);
    expect(m.get("t1")).not.toBeNull();
  });
});
