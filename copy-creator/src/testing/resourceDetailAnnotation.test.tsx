// @vitest-environment jsdom
// 划选标注链路的复现测试：正文渲染后模拟真实 Selection + mouseup，
// 断言玻璃工具条出现（用户实测「划完没有出现功能条」的回归钉子）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

afterEach(cleanup);

const TEXT = [
  "第一行的示例文本，用来模拟小说正文。",
  "第二行的示例文本，拖选这一段应当弹出工具条。",
  "第三行收尾。",
].join("\n");

const invokeMock = vi.fn(async (cmd: string) => {
  if (cmd === "read_resource_text_detail") {
    return { content: TEXT, truncated: false };
  }
  if (cmd === "get_resource_annotations") return [];
  return null;
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => invokeMock(cmd),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import "../i18n";
import ResourceDetailPage from "../pages/ResourcePage/ResourceDetailPage";
import type { ClipboardRecord } from "../types";

const record: ClipboardRecord = {
  id: "resource-file:/lib/audio_log.txt",
  type: "file",
  content: "/lib/audio_log.txt",
  source_app: "",
  created_at: "2026-10-10T15:22:30Z",
  storage_mode: "resource",
  resource_path: "/lib/audio_log.txt",
};

function renderDetail() {
  return render(
    <ResourceDetailPage
      record={record}
      typeLabel={() => "文本"}
      onBack={() => {}}
      onCopy={() => {}}
      onDelete={() => {}}
      onRecordUpdated={() => {}}
    />,
  );
}

async function selectText(container: HTMLElement, needle: string) {
  const chunk = container.querySelector<HTMLElement>("[data-chunk-start]");
  if (!chunk) throw new Error("chunk 未渲染");
  const walker = document.createTreeWalker(chunk, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const idx = node.textContent?.indexOf(needle) ?? -1;
    if (idx >= 0) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + needle.length);
      selection?.addRange(range);
      return chunk;
    }
  }
  throw new Error(`未找到目标文本: ${needle}`);
}

describe("资源详情页划选标注", () => {
  it("划选正文后弹出标注工具条", async () => {
    const { container } = renderDetail();
    // 全文读取是异步的：等 chunk 带正文渲染完成。
    await waitFor(() => {
      expect(container.querySelector("[data-chunk-start]")?.textContent).toContain("第二行");
    });

    const chunk = await selectText(container, "第二行的示例文本");
    chunk.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    // handler 内部有 10ms 的 selection 结算延时。
    await new Promise((resolve) => setTimeout(resolve, 60));

    const toolbar = container.querySelector(".annotation-toolbar");
    expect(toolbar).not.toBeNull();
    expect(container.querySelector(".annotation-toolbar .tb-btn")).not.toBeNull();
  });
});

describe("正文列滚动进度条", () => {
  it("滚动时 thumb 位置随滚动进度更新", async () => {
    const { container } = renderDetail();
    await waitFor(() => {
      expect(container.querySelector("[data-chunk-start]")?.textContent).toContain("第二行");
    });
    const main = container.querySelector(".resource-detail-main") as HTMLElement;
    const thumb = container.querySelector(".resource-main-scrollbar-thumb") as HTMLElement;

    // jsdom 无布局：直接钳制几何值让计算可断言
    const mockRect = (el: HTMLElement, h: number) => {
      el.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: h, right: 100, width: 100, height: h, x: 0, y: 0, toJSON: () => ({}) });
    };
    mockRect(main, 600);

    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    let first: Text | null = null;
    while (walker.nextNode()) { first = walker.currentNode as Text; break; }
    const textLen = first!.textContent!.length;

    // 滚到中段（scrollHeight 模拟远超视口的长内容）
    Object.defineProperty(main, "scrollTop", { value: 6000, configurable: true });
    Object.defineProperty(main, "scrollHeight", { value: 12000, configurable: true });
    Object.defineProperty(main, "clientHeight", { value: 600, configurable: true });
    main.dispatchEvent(new Event("scroll"));

    await new Promise((r) => setTimeout(r, 50));
    const ty = parseFloat(thumb.style.transform.replace(/[^\d.]/g, ""));
    expect(thumb.style.height).not.toBe("");
    expect(ty).toBeGreaterThan(0);
  });
});

describe("正文列滚动进度条", () => {
  it("滚动时 thumb 位置随滚动进度更新", async () => {
    const { container } = renderDetail();
    await waitFor(() => {
      expect(container.querySelector("[data-chunk-start]")?.textContent).toContain("第二行");
    });
    const main = container.querySelector(".resource-detail-main") as HTMLElement;
    const thumb = container.querySelector(".resource-main-scrollbar-thumb") as HTMLElement;
    expect(thumb).not.toBeNull();

    // jsdom 无布局：钳制几何值让计算可断言
    main.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 600, right: 100, width: 100, height: 600, x: 0, y: 0, toJSON: () => ({}) });

    // 定位包含目标文本的正文节点（walker 可能先遍历到非正文文本节点）
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    let textNode: Text | null = null;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.textContent?.includes("第二行的示例文本")) { textNode = node as Text; break; }
    }
    if (!textNode) throw new Error("正文节点未找到");
    const textLen = textNode.textContent!.length;

    Object.defineProperty(main, "scrollTop", { value: 0, configurable: true });
    Object.defineProperty(main, "scrollHeight", { value: textLen, configurable: true });
    Object.defineProperty(main, "clientHeight", { value: 600, configurable: true });
    // 触发初始更新（effect 绑定时的 update + 事件）
    main.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 50));
    const topAtZero = parseFloat(thumb.style.transform.replace(/[^\d.-]/g, "")) || 0;

    // 滚到中段
    Object.defineProperty(main, "scrollTop", { value: Math.round(textLen / 2), configurable: true });
    main.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 50));
    const tyMid = parseFloat(thumb.style.transform.replace(/[^\d.-]/g, "")) || 0;

    // 滚到底
    Object.defineProperty(main, "scrollTop", { value: Math.max(0, textLen - 600), configurable: true });
    main.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 50));
    const tyEnd = parseFloat(thumb.style.transform.replace(/[^\d.-]/g, "")) || 0;

    console.log("THUMB DEBUG:", JSON.stringify({
      topAtZero, tyMid, tyEnd,
      st: (main as HTMLElement).scrollTop,
      sh: (main as HTMLElement).scrollHeight,
      ch: (main as HTMLElement).clientHeight,
      transform: thumb.style.transform,
      height: thumb.style.height,
      mainElConnected: main.isConnected,
    }));
    expect(topAtZero).toBeGreaterThanOrEqual(14); // 顶部基准留边 14px
    expect(tyMid).toBeGreaterThan(topAtZero);
    expect(tyEnd).toBeGreaterThan(tyMid);
  });
});
