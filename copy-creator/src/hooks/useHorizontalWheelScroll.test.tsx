// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { createRef } from "react";
import { useHorizontalWheelScroll } from "./useHorizontalWheelScroll";

function Host({ refObj, resetKey }: { refObj: React.RefObject<HTMLDivElement | null>; resetKey?: unknown }) {
  useHorizontalWheelScroll(refObj, resetKey);
  return <div ref={refObj} />;
}

describe("useHorizontalWheelScroll", () => {
  it("converts vertical-dominant wheel input into horizontal scrolling and prevents default", () => {
    const ref = createRef<HTMLDivElement>();
    render(<Host refObj={ref} />);
    const element = ref.current!;

    const event = new WheelEvent("wheel", { deltaY: 120, deltaX: 0, cancelable: true });
    element.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(element.scrollLeft).toBe(120);
  });

  it("ignores horizontal-dominant wheel input", () => {
    const ref = createRef<HTMLDivElement>();
    render(<Host refObj={ref} />);
    const element = ref.current!;

    const event = new WheelEvent("wheel", { deltaY: 10, deltaX: 120, cancelable: true });
    element.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(element.scrollLeft).toBe(0);
  });

  it("rebinds the listener when the container node is remounted (resetKey change)", () => {
    // 模拟径向菜单按 tab 切换重建分类条：resetKey 变化伴随容器节点重建。
    const ref = createRef<HTMLDivElement>();
    function SwapHost({ resetKey }: { resetKey: string }) {
      useHorizontalWheelScroll(ref, resetKey);
      return resetKey === "a"
        ? <div ref={ref} data-testid="first" />
        : <div ref={ref} data-testid="second" />;
    }
    const { getByTestId, rerender } = render(<SwapHost resetKey="a" />);
    expect(getByTestId("first")).toBeTruthy();

    rerender(<SwapHost resetKey="b" />);
    const second = getByTestId("second");

    const event = new WheelEvent("wheel", { deltaY: 60, deltaX: 0, cancelable: true });
    second.dispatchEvent(event);
    expect(second.scrollLeft).toBe(60);
  });
});
