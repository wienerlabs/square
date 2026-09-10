import { describe, expect, it } from "vitest";
import { focusCycleIndex } from "./focus";

describe("focusCycleIndex", () => {
  it("wraps forward from the last control back to the first", () => {
    expect(focusCycleIndex(3, 0, false)).toBe(1);
    expect(focusCycleIndex(3, 1, false)).toBe(2);
    expect(focusCycleIndex(3, 2, false)).toBe(0);
  });

  it("wraps backward from the first control to the last", () => {
    expect(focusCycleIndex(3, 2, true)).toBe(1);
    expect(focusCycleIndex(3, 1, true)).toBe(0);
    expect(focusCycleIndex(3, 0, true)).toBe(2);
  });

  it("pulls focus into the dialog when it currently sits outside it", () => {
    expect(focusCycleIndex(3, -1, false)).toBe(0);
    expect(focusCycleIndex(3, -1, true)).toBe(2);
  });

  it("stays put when the dialog holds nothing focusable", () => {
    expect(focusCycleIndex(0, -1, false)).toBe(-1);
    expect(focusCycleIndex(0, 0, true)).toBe(-1);
  });

  it("keeps a single control focused in both directions", () => {
    expect(focusCycleIndex(1, 0, false)).toBe(0);
    expect(focusCycleIndex(1, 0, true)).toBe(0);
  });
});
