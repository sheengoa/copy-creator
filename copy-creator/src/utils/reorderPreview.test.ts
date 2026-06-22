import { describe, expect, it } from "vitest";
import { getChangedOrderIds, getDragPreviewOrder } from "./reorderPreview";

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

describe("getChangedOrderIds", () => {
  it("returns final ids when preview order differs from original order", () => {
    const preview = [items[0], items[2], items[3], items[1]];

    expect(getChangedOrderIds(items, preview)).toEqual(["a", "c", "d", "b"]);
  });

  it("returns null when preview order matches original order", () => {
    expect(getChangedOrderIds(items, items)).toBeNull();
  });

  it("returns null when preview was not created", () => {
    expect(getChangedOrderIds(items, null)).toBeNull();
  });
});
