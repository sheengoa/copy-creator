// @vitest-environment jsdom
// 划选标注链路的复现测试：正文渲染后模拟真实 Selection + mouseup，
// 断言玻璃工具条出现（用户实测「划完没有出现功能条」的回归钉子）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

afterEach(cleanup);

const TEXT = Array.from({ length: 10 }, () => [
  "第一行的示例文本，用来模拟小说正文。",
  "第二行的示例文本，拖选这一段应当弹出工具条。",
  "第三行收尾。",
].join("\n")).join("\n");

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
  // 滚动跟随已在真实 WebKitGTK 环境实测（inspector 驱动滚动、thumb
  // 位置随进度更新）；jsdom 无布局引擎，几何 mock 断言失真故不在此
  // 重复，仅钉住结构渲染契约。
  it("渲染滚动进度条轨道与 thumb（初始位置由页面按滚动进度写入）", async () => {
    const { container } = renderDetail();
    await waitFor(() => {
      expect(container.querySelector("[data-chunk-start]")?.textContent).toContain("第二行");
    });
    const track = container.querySelector(".resource-main-scrollbar-track");
    const thumb = container.querySelector(".resource-main-scrollbar-thumb");
    expect(track).not.toBeNull();
    expect(thumb).not.toBeNull();
    expect(track!.className).toContain("resource-main-scrollbar-track");
  });
});
