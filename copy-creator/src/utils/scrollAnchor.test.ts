// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyListScrollAnchor, captureListScrollAnchor, type ListScrollAnchor } from "./scrollAnchor";

type RectStub = { top: number; bottom: number };

function stubRect(element: HTMLElement, rect: RectStub) {
  element.getBoundingClientRect = () =>
    ({
      top: rect.top,
      bottom: rect.bottom,
      left: 0,
      right: 100,
      width: 100,
      height: rect.bottom - rect.top,
      x: 0,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function createList(itemTops: [string, RectStub][]): { container: HTMLElement; items: HTMLElement[] } {
  const container = document.createElement("div");
  const items = itemTops.map(([id, rect]) => {
    const item = document.createElement("div");
    item.dataset.radialItemId = id;
    stubRect(item, rect);
    container.appendChild(item);
    return item;
  });
  document.body.appendChild(container);
  return { container, items };
}

describe("captureListScrollAnchor", () => {
  it("捕获视口顶条目及其偏移", () => {
    const { container } = createList([
      ["a", { top: -200, bottom: -20 }],
      ["b", { top: 12, bottom: 120 }],
      ["c", { top: 120, bottom: 240 }],
    ]);
    stubRect(container, { top: 0, bottom: 400 });
    Object.defineProperty(container, "scrollTop", { value: 300, writable: true, configurable: true });

    expect(captureListScrollAnchor(container, "resources|all")).toEqual({
      viewKey: "resources|all",
      itemId: "b",
      offsetInViewport: 12,
      scrollTop: 300,
    });
  });

  it("首条目仍在视口内时捕获首条目", () => {
    const { container } = createList([
      ["a", { top: 5, bottom: 100 }],
      ["b", { top: 100, bottom: 200 }],
    ]);
    stubRect(container, { top: 0, bottom: 400 });

    const anchor = captureListScrollAnchor(container, "k");
    expect(anchor?.itemId).toBe("a");
    expect(anchor?.offsetInViewport).toBe(5);
  });

  it("无条目（空态）时 itemId 为 null，仍带像素位置", () => {
    const container = document.createElement("div");
    stubRect(container, { top: 0, bottom: 400 });
    Object.defineProperty(container, "scrollTop", { value: 0, writable: true, configurable: true });

    expect(captureListScrollAnchor(container, "k")).toEqual({
      viewKey: "k",
      itemId: null,
      offsetInViewport: 0,
      scrollTop: 0,
    });
  });

  it("容器为 null 返回 null", () => {
    expect(captureListScrollAnchor(null, "k")).toBeNull();
  });
});

describe("applyListScrollAnchor", () => {
  const anchor: ListScrollAnchor = {
    viewKey: "resources|all",
    itemId: "b",
    offsetInViewport: 10,
    scrollTop: 300,
  };

  it("条目仍在列表时按条目精确对位", () => {
    // 重排后 b 从旧位置移动到新位置（top=60）：把 scrollTop 增加使 b 回到 10px 偏移。
    const { container } = createList([
      ["x", { top: -140, bottom: 40 }],
      ["b", { top: 40, bottom: 160 }],
    ]);
    stubRect(container, { top: 0, bottom: 400 });
    Object.defineProperty(container, "scrollTop", { value: 200, writable: true, configurable: true });

    expect(applyListScrollAnchor(container, anchor, "resources|all")).toBe(true);
    expect(container.scrollTop).toBe(200 + (40 - 10));
  });

  it("条目已删除时退回像素位置", () => {
    const { container } = createList([["x", { top: 0, bottom: 120 }]]);
    stubRect(container, { top: 0, bottom: 400 });
    Object.defineProperty(container, "scrollTop", { value: 88, writable: true, configurable: true });

    expect(applyListScrollAnchor(container, anchor, "resources|all")).toBe(false);
    expect(container.scrollTop).toBe(300);
  });

  it("viewKey 不匹配（视图已切换）不动滚动位置", () => {
    const { container } = createList([["b", { top: 40, bottom: 160 }]]);
    stubRect(container, { top: 0, bottom: 400 });
    Object.defineProperty(container, "scrollTop", { value: 55, writable: true, configurable: true });

    expect(applyListScrollAnchor(container, anchor, "clipboard|all")).toBe(false);
    expect(container.scrollTop).toBe(55);
  });

  it("锚点或容器为空时安全返回", () => {
    const { container } = createList([["b", { top: 0, bottom: 100 }]]);
    stubRect(container, { top: 0, bottom: 400 });
    expect(applyListScrollAnchor(container, null, "k")).toBe(false);
    expect(applyListScrollAnchor(null, anchor, "k")).toBe(false);
  });
});
