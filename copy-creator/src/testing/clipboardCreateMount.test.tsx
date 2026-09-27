// @vitest-environment jsdom
// 诊断性挂载测试：验证 ClipboardCreateDialog 在 Tauri API 打桩后能否完整渲染。
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const invokeMock = vi.fn(async (cmd: string) => {
  if (cmd === "get_setting") return "";
  return [];
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => invokeMock(cmd),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: vi.fn(async () => () => {}),
    onCloseRequested: vi.fn(async () => () => {}),
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    startResizeDragging: vi.fn(async () => {}),
    scaleFactor: async () => 1,
  }),
}));

import ClipboardCreateDialog from "../components/ClipboardCreateDialog";

// jsdom 不实现 innerText（StashEditor 摘要逻辑依赖），用 textContent 等价替身。
Object.defineProperty(HTMLElement.prototype, "innerText", {
  get(this: HTMLElement) {
    return this.textContent ?? "";
  },
  configurable: true,
});

describe("ClipboardCreateDialog 挂载诊断", () => {
  it("能在 mock 环境下完整渲染出头部与动作按钮", () => {
    const { container } = render(<ClipboardCreateDialog />);
    expect(container.querySelector(".clipboard-create-dialog")).toBeTruthy();
    expect(container.querySelector(".clipboard-create-header")).toBeTruthy();
    expect(container.querySelector(".window-header-actions")).toBeTruthy();
    expect(container.querySelector(".window-min-btn")).toBeTruthy();
    expect(container.querySelector(".window-max-btn")).toBeTruthy();
    expect(container.querySelector(".window-close-btn")).toBeTruthy();
  });
});
