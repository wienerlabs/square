import { specDescription, specHash } from "@squaresdk/core";
import { describe, expect, it } from "vitest";
import { checkSpec } from "./spec";

const spec = {
  task: "Label 500 product images with exactly one of: shoe, bag, jacket, other",
  deliverable: "labels.jsonl with one {file, label} object per line",
  acceptance: "A spot check of 50 images agrees with the labels on at least 48",
};
const description = specDescription(spec);

describe("checkSpec", () => {
  it("matches the text the on-chain hash was made from, whatever the key order and the whitespace", () => {
    expect(checkSpec(JSON.stringify(spec), description)).toEqual({ kind: "match" });
    expect(checkSpec(JSON.stringify({ acceptance: spec.acceptance, deliverable: spec.deliverable, task: spec.task }, null, 4), description)).toEqual({
      kind: "match",
    });
  });

  it("reports a mismatch with the hash the pasted text actually makes", () => {
    const edited = { ...spec, acceptance: "A spot check of 50 images agrees with the labels on at least 49" };
    expect(checkSpec(JSON.stringify(edited), description)).toEqual({ kind: "mismatch", hash: specHash(edited) });
  });

  it("stays silent on an empty box and names the parse error on broken JSON", () => {
    expect(checkSpec("   ", description)).toEqual({ kind: "empty" });
    expect(checkSpec("{", description).kind).toBe("invalid");
  });

  it("cannot match a description that carries no spec hash", () => {
    expect(checkSpec(JSON.stringify(spec), "a plain description").kind).toBe("mismatch");
  });
});
