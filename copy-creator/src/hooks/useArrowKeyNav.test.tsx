// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { useRef } from "react";
import { useArrowKeyNav } from "./useArrowKeyNav";

// jsdom 未实现 scrollIntoView。
beforeEach(() => {
  Element.prototype.scrollIntoView = () => {};
});

const fireKey = (target: Element, key: string) => {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
};

function FlatList() {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = useArrowKeyNav({ containerRef: ref, itemSelector: ".item" });
  return (
    <div ref={ref} onKeyDown={onKeyDown}>
      <div className="item" tabIndex={0}>a</div>
      <div className="item" tabIndex={0}>b</div>
      <div className="item" tabIndex={0}>c</div>
    </div>
  );
}

function Masonry() {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = useArrowKeyNav({
    containerRef: ref,
    itemSelector: ".item",
    columnar: true,
    columnSelector: ".col",
  });
  return (
    <div ref={ref} onKeyDown={onKeyDown}>
      <div className="col">
        <div className="item" tabIndex={0}>a1</div>
        <div className="item" tabIndex={0}>a2</div>
      </div>
      <div className="col">
        <div className="item" tabIndex={0}>b1</div>
      </div>
    </div>
  );
}

const text = (el: Element | null) => (el ? el.textContent : null);
const focus = (el: Element) => (el as HTMLElement).focus();

describe("useArrowKeyNav 垂直列表", () => {
  it("从容器外按 下键 进入第一项", () => {
    const { container } = render(<FlatList />);
    fireKey(container.firstElementChild!, "ArrowDown");
    expect(document.activeElement).toBe(container.querySelectorAll(".item")[0]);
  });

  it("从容器外按 上键 进入最后一项", () => {
    const { container } = render(<FlatList />);
    fireKey(container.firstElementChild!, "ArrowUp");
    expect(text(document.activeElement)).toBe("c");
  });

  it("上下键在条目间顺序移动，到边界不动", () => {
    const { container } = render(<FlatList />);
    const items = container.querySelectorAll(".item");
    focus(items[0]);
    fireKey(items[0], "ArrowDown");
    expect(text(document.activeElement)).toBe("b");
    fireKey(document.activeElement!, "ArrowDown");
    expect(text(document.activeElement)).toBe("c");
    fireKey(document.activeElement!, "ArrowDown");
    expect(text(document.activeElement)).toBe("c");
    fireKey(document.activeElement!, "ArrowUp");
    expect(text(document.activeElement)).toBe("b");
  });

  it("焦点在卡片内部元素时回溯到卡片再移动", () => {
    function Nested() {
      const ref = useRef<HTMLDivElement>(null);
      const onKeyDown = useArrowKeyNav({ containerRef: ref, itemSelector: ".item" });
      return (
        <div ref={ref} onKeyDown={onKeyDown}>
          <div className="item" tabIndex={0}>
            <button className="inner">x</button>
          </div>
          <div className="item" tabIndex={0}>b</div>
        </div>
      );
    }
    const { container } = render(<Nested />);
    focus(container.querySelector(".inner")!);
    fireKey(container.querySelector(".inner")!, "ArrowDown");
    expect(text(document.activeElement)).toBe("b");
  });

  it("普通点击等未消费键不拦截（无 preventDefault 也不移动焦点）", () => {
    const { container } = render(<FlatList />);
    const items = container.querySelectorAll(".item");
    focus(items[1]);
    fireKey(items[1], "Enter");
    expect(text(document.activeElement)).toBe("b");
  });
});

describe("useArrowKeyNav 瀑布流", () => {
  it("上下键在列内移动，列边界不环绕", () => {
    const { container } = render(<Masonry />);
    const a1 = container.querySelectorAll(".item")[0];
    focus(a1);
    fireKey(a1, "ArrowDown");
    expect(text(document.activeElement)).toBe("a2");
    fireKey(document.activeElement!, "ArrowDown");
    expect(text(document.activeElement)).toBe("a2");
  });

  it("左右键跨列同位移动，目标列越界取末位", () => {
    const { container } = render(<Masonry />);
    const items = container.querySelectorAll(".item");
    focus(items[1]); // a2（第 0 列第 1 位）
    fireKey(document.activeElement!, "ArrowRight");
    expect(text(document.activeElement)).toBe("b1"); // 第 1 列只有 1 项，取末位
    fireKey(document.activeElement!, "ArrowLeft");
    expect(text(document.activeElement)).toBe("a1"); // b1 位于第 0 位，同位回到第 0 列第 0 位
  });
});
