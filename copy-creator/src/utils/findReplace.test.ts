import { describe, expect, it } from "vitest";
import { findMatchPositions } from "./findReplace";

describe("findMatchPositions", () => {
  it("finds all non-overlapping matches", () => {
    expect(findMatchPositions("aaaa", "aa", true)).toEqual([0, 2]);
    expect(findMatchPositions("项目约定，项目目标", "项目", true)).toEqual([0, 5]);
  });

  it("returns empty for empty query or no match", () => {
    expect(findMatchPositions("hello", "", true)).toEqual([]);
    expect(findMatchPositions("hello", "world", true)).toEqual([]);
  });

  it("honors case sensitivity", () => {
    expect(findMatchPositions("Hello hello HELLO", "hello", true)).toEqual([6]);
    expect(findMatchPositions("Hello hello HELLO", "hello", false)).toEqual([0, 6, 12]);
  });
});
