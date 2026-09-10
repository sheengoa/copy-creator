import { describe, expect, it } from "vitest";
import { sortByIdOrder } from "./reorder";

describe("sortByIdOrder", () => {
  it("places the given ids first in their order, keeping the rest in place", () => {
    const items = [
      { id: "a", label: "a" },
      { id: "b", label: "b" },
      { id: "c", label: "c" },
      { id: "d", label: "d" },
    ];
    const sorted = sortByIdOrder(items, ["d", "b"]);

    expect(sorted.map((item) => item.id)).toEqual(["d", "b", "a", "c"]);
  });

  it("does not mutate the input array", () => {
    const items = [{ id: "a" }, { id: "b" }];
    sortByIdOrder(items, ["b"]);

    expect(items.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("keeps the original order when no ids are given", () => {
    const items = [{ id: "b" }, { id: "a" }];

    expect(sortByIdOrder(items, []).map((item) => item.id)).toEqual(["b", "a"]);
  });

  it("ignores unknown ids in the requested order", () => {
    const items = [{ id: "a" }, { id: "b" }];

    expect(sortByIdOrder(items, ["ghost", "b"]).map((item) => item.id)).toEqual(["b", "a"]);
  });
});
