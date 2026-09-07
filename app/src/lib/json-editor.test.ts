import { describe, expect, it } from "vitest";
import { errorLine, tokenize } from "./json-editor";

describe("tokenize", () => {
  it("tells keys from string values and colours the rest", () => {
    const kinds = tokenize('{"task": "Review", "count": 3, "open": true, "x": null}').map((token) => token.kind);
    expect(kinds).toEqual([
      "punct", "key", "punct", "space", "string", "punct", "space",
      "key", "punct", "space", "number", "punct", "space",
      "key", "punct", "space", "literal", "punct", "space",
      "key", "punct", "space", "literal", "punct",
    ]);
  });

  it("marks characters JSON has no place for", () => {
    expect(tokenize("@").map((token) => token.kind)).toEqual(["other"]);
  });
});

describe("errorLine", () => {
  const source = '{\n  "task": "x",\n  "bad" 1\n}';

  it("reads a line from the message when the engine gives one", () => {
    expect(errorLine("Expected ':' after property name in JSON at position 22 (line 3 column 9)", source)).toBe(3);
  });

  it("derives the line from a position otherwise", () => {
    expect(errorLine("Unexpected token 1 in JSON at position 22", source)).toBe(3);
  });

  it("falls back to the last line, and to nothing without a message", () => {
    expect(errorLine("Unexpected end of JSON input", source)).toBe(4);
    expect(errorLine(null, source)).toBeNull();
    expect(errorLine("anything", "")).toBeNull();
  });
});
