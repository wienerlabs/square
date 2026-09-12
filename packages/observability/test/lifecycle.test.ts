import { describe, it, expect } from "vitest";
import { getEventListeners } from "node:events";
import { waitUnlessAborted } from "../src/lifecycle.js";

describe("waitUnlessAborted", () => {
  it("leaves no listener on the signal after thirty completed waits", async () => {
    const controller = new AbortController();
    for (let tick = 0; tick < 30; tick += 1) {
      await waitUnlessAborted(0, controller.signal);
      expect(getEventListeners(controller.signal, "abort").length).toBeLessThanOrEqual(1);
    }
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("returns instead of throwing when the wait is aborted", async () => {
    const controller = new AbortController();
    const waiting = waitUnlessAborted(60_000, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBeUndefined();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("returns at once when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const startedAt = Date.now();
    await waitUnlessAborted(60_000, controller.signal);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
