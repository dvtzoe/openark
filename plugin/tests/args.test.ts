import { describe, expect, it } from "vitest";
import { filteredStringArray, requiredString } from "../src/core/args";

describe("requiredString", () => {
  const schema = requiredString("text is required");

  it("passes through a non-empty string, trimmed", () => {
    expect(schema.parse("  hello  ")).toBe("hello");
  });

  it("rejects a missing value with the custom message", () => {
    expect(() => schema.parse(undefined)).toThrow("text is required");
  });

  it("rejects a blank string with the custom message", () => {
    expect(() => schema.parse("   ")).toThrow("text is required");
  });

  it("treats a non-string as empty rather than a distinct error", () => {
    expect(() => schema.parse(42)).toThrow("text is required");
  });
});

describe("filteredStringArray", () => {
  const schema = filteredStringArray();

  it("passes through valid non-blank strings", () => {
    expect(schema.parse(["a", "b"])).toEqual(["a", "b"]);
  });

  it("drops blank strings and non-string elements instead of rejecting the whole array", () => {
    expect(schema.parse(["valid", "  ", 42, "also valid"])).toEqual(["valid", "also valid"]);
  });

  it("treats a non-array as an empty array rather than a distinct error", () => {
    expect(schema.parse("not-an-array")).toEqual([]);
    expect(schema.parse(undefined)).toEqual([]);
  });
});
