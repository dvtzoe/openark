import { describe, expect, it } from "vitest";
import { pushBounded } from "../src/core/bounded-buffer";

describe("pushBounded", () => {
  it("appends while under capacity", () => {
    const buf: number[] = [1, 2];
    pushBounded(buf, 3, 5);
    expect(buf).toEqual([1, 2, 3]);
  });

  it("evicts the oldest entry once at capacity", () => {
    const buf = [1, 2, 3];
    pushBounded(buf, 4, 3);
    expect(buf).toEqual([2, 3, 4]);
  });

  it("mutates the array in place", () => {
    const buf: number[] = [];
    const same = buf;
    pushBounded(buf, 1, 2);
    expect(same).toBe(buf);
    expect(same).toEqual([1]);
  });
});
