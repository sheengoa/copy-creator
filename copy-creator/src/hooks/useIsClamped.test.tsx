// @vitest-environment jsdom
// useIsClamped：-webkit-line-clamp 截断检测（scrollHeight > clientHeight
// 点亮 .is-clamped 渐隐提示）。jsdom 无真实排版，用可控 ResizeObserver
// 桩 + 实例级尺寸打桩驱动测量回调。
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsClamped } from "./useIsClamped";

interface StubObserver {
  cb: ResizeObserverCallback;
  observe: (node: Element) => void;
  disconnect: () => void;
}

let stubInstances: StubObserver[] = [];
let observedNodes: Element[] = [];

class MockResizeObserver {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    const instance: StubObserver = {
      cb,
      observe: (node: Element) => {
        observedNodes.push(node);
      },
      disconnect: () => undefined,
    };
    stubInstances.push(instance);
  }
  observe(node: Element) {
    observedNodes.push(node);
  }
  disconnect() {}
  unobserve() {}
  takeRecords() {
    return [];
  }
}

vi.stubGlobal("ResizeObserver", MockResizeObserver);

afterEach(() => {
  cleanup();
  stubInstances = [];
  observedNodes = [];
});

function setBoxSize(node: Element, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(node, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(node, "clientHeight", { value: clientHeight, configurable: true });
}

function Probe() {
  const [ref, clamped] = useIsClamped();
  return (
    <div ref={ref} data-clamped={clamped ? "1" : "0"} className="probe">
      长文正文
    </div>
  );
}

function fireObserver(index: number) {
  // 测量回调里 setState，包 act 保证 DOM 同步刷出。
  act(() => {
    stubInstances[index]?.cb([], stubInstances[index] as unknown as ResizeObserver);
  });
}

describe("useIsClamped", () => {
  it("挂载即测一次：未超出（jsdom 默认 0 尺寸）判为未截断", () => {
    const { container } = render(<Probe />);
    const probe = container.querySelector(".probe")!;
    expect(observedNodes).toContain(probe);
    expect(probe.getAttribute("data-clamped")).toBe("0");
  });

  it("ResizeObserver 回调时 scrollHeight > clientHeight → 点亮截断态", () => {
    const { container } = render(<Probe />);
    const probe = container.querySelector(".probe")!;
    setBoxSize(probe, 200, 100);
    fireObserver(0);
    expect(probe.getAttribute("data-clamped")).toBe("1");
  });

  it("恰好占满（scrollHeight == clientHeight）不误判截断；1px 容差内同样不算", () => {
    const { container } = render(<Probe />);
    const probe = container.querySelector(".probe")!;
    setBoxSize(probe, 100, 100);
    fireObserver(0);
    expect(probe.getAttribute("data-clamped")).toBe("0");
    setBoxSize(probe, 101, 100);
    fireObserver(0);
    expect(probe.getAttribute("data-clamped")).toBe("0");
  });

  it("节点更换（ref 重挂）断开旧观察、重新测量新节点", () => {
    const { container, rerender } = render(<Probe key="a" />);
    expect(stubInstances.length).toBe(1);
    rerender(<Probe key="b" />);
    // 新节点挂载后旧 observer 断开、新 observer 就位并立即测量。
    expect(stubInstances.length).toBe(2);
    expect(container.querySelector(".probe")!.getAttribute("data-clamped")).toBe("0");
  });
});
