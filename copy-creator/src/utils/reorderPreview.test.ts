import { describe, expect, it } from "vitest";
import { getDragPreviewOrder } from "./reorderPreview";

const items = [
  { id: "a", label: "A" },
  { id: "b", label: "B" },
  { id: "c", label: "C" },
  { id: "d", label: "D" },
];

describe("getDragPreviewOrder", () => {
  it("moves the active item before the hovered item when dragging upward", () => {
    expect(getDragPreviewOrder(items, "d", "b").map((item) => item.id)).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
  });

  it("moves the active item after intervening items when dragging downward", () => {
    expect(getDragPreviewOrder(items, "b", "d").map((item) => item.id)).toEqual([
      "a",
      "c",
      "d",
      "b",
    ]);
  });

  it("returns the same array reference when there is no usable hover target", () => {
    expect(getDragPreviewOrder(items, "b", null)).toBe(items);
    expect(getDragPreviewOrder(items, "b", "b")).toBe(items);
    expect(getDragPreviewOrder(items, "missing", "b")).toBe(items);
    expect(getDragPreviewOrder(items, "b", "missing")).toBe(items);
  });
});
