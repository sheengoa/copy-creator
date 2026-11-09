// @vitest-environment jsdom
// 资源详情页顶栏「刷新」按钮守护测试：点击重读文件并渲染新内容（其他
// 入口/外部程序改文后的手动同步）、全文读取失败时经截断预览兜底照常
// 刷新（兼作重试入口）、编辑态与历史版本预览态隐藏（防误伤草稿、防与
// 快照语义冲突）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

afterEach(() => {
  cleanup();
  detailCall = 0;
  detailFailOnRefresh = false;
  versionRows = [];
});

const TEXT_V1 = "刷新前的旧正文。\n第二行。\n";
const TEXT_V2 = "外部编辑后的新正文，附带不同收尾。\n";

// 第二次全文读取（点刷新）可切换返回内容；置真后改为 reject，
// 验证失败回退 1MB 截断预览的兜底链路。
let detailCall = 0;
let detailFailOnRefresh = false;
// 版本列表内容按用例注入（默认空；预览态用例放两个版本才有旧版可点）。
let versionRows: unknown[] = [];

const invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === "read_resource_text_detail") {
    expect(args?.path).toBe(record.resource_path);
    detailCall += 1;
    if (detailCall > 1 && detailFailOnRefresh) {
      throw "文件丢失";
    }
    return { content: detailCall > 1 ? TEXT_V2 : TEXT_V1, truncated: false };
  }
  if (cmd === "read_resource_text_preview") {
    return { content: "1MB截断预览收尾", truncated: true };
  }
  if (cmd === "get_resource_annotations") return [];
  if (cmd === "list_resource_text_versions") return versionRows;
  if (cmd === "get_resource_text_version_content") return "入库时的旧内容";
  return null;
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
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
  resource_file_size: 100,
};

function renderDetail(recordOverride: Partial<ClipboardRecord> = {}) {
  return render(
    <ResourceDetailPage
      record={{ ...record, ...recordOverride }}
      typeLabel={() => "文本"}
      onBack={() => {}}
      onDelete={() => {}}
      onRecordUpdated={() => {}}
    />,
  );
}

function findButton(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(label),
  );
}

describe("资源详情页刷新按钮", () => {
  it("点击刷新重读文件并渲染新内容", async () => {
    const { container } = renderDetail();
    await waitFor(() => {
      expect(container.querySelector("[data-chunk-start]")?.textContent).toContain("旧正文");
    });

    const refresh = findButton(container, "刷新");
    expect(refresh).toBeTruthy();
    refresh!.click();
    await waitFor(() => {
      expect(container.querySelector("[data-chunk-start]")?.textContent).toContain("新正文");
    });
    // 全文读取命令按同一路径重跑一次（打开 + 刷新各一次）。
    const detailCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "read_resource_text_detail");
    expect(detailCalls.length).toBe(2);
  });

  it("刷新落到全文读取失败时经截断预览兜底照常更新（兼作重试入口）", async () => {
    const { container } = renderDetail();
    await waitFor(() => {
      expect(container.querySelector("[data-chunk-start]")?.textContent).toContain("旧正文");
    });
    detailFailOnRefresh = true;
    findButton(container, "刷新")!.click();
    await waitFor(() => {
      expect(container.querySelector("[data-chunk-start]")?.textContent).toContain("截断预览收尾");
    });
  });

  it("编辑内容进行中隐藏刷新按钮", async () => {
    const { container } = renderDetail();
    await waitFor(() => {
      expect(container.querySelector("[data-chunk-start]")).not.toBeNull();
    });
    expect(findButton(container, "刷新")).toBeTruthy();
    findButton(container, "编辑内容")!.click();
    await waitFor(() => {
      expect(findButton(container, "保存修改")).toBeTruthy();
    });
    expect(findButton(container, "刷新")).toBeUndefined();
  });

  it("历史版本只读预览态隐藏刷新按钮", async () => {
    // 两个版本才有可预览的旧版（最新一版是「当前」项，点击语义是回最新）。
    versionRows = [
      {
        id: "rtv-2",
        record_id: record.id,
        byte_size: 120,
        source: "edit",
        created_at: "2026-10-23T10:00:00+08:00",
      },
      {
        id: "rtv-1",
        record_id: record.id,
        byte_size: 96,
        source: "init",
        created_at: "2026-10-20T09:00:00+08:00",
      },
    ];
    const { container } = renderDetail();
    await waitFor(() => {
      expect(container.querySelector("[data-chunk-start]")).not.toBeNull();
    });
    findButton(container, "改动记录")!.click();
    const item = await waitFor(() => {
      const items = container.querySelectorAll(".text-history-item");
      if (items.length < 2) throw new Error("版本列表未渲染");
      return items[1];
    });
    item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => {
      expect(container.querySelector(".resource-version-banner")).not.toBeNull();
    });
    expect(findButton(container, "刷新")).toBeUndefined();
  });
});
