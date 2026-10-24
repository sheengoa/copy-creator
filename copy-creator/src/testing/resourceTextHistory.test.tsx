// @vitest-environment jsdom
// 资源文本「改动记录」与详情页「打开所在位置」组件守护测试：面板列表、
// 版本只读预览、一键还原与清空的渲染契约（还原自动记版、当前项点击回
// 最新等防回归钉子）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

afterEach(() => {
  cleanup();
  emptyHistory = false;
});

const TEXT = "第一行的示例文本，用来模拟小说正文。\n第二行收尾。\n";

const VERSIONS = [
  {
    id: "rtv-2",
    record_id: "resource-file:/lib/audio_log.txt",
    byte_size: 120,
    source: "edit",
    created_at: "2026-10-23T10:00:00+08:00",
  },
  {
    id: "rtv-1",
    record_id: "resource-file:/lib/audio_log.txt",
    byte_size: 96,
    source: "init",
    created_at: "2026-10-20T09:00:00+08:00",
  },
];

// 空态用例的开关（Once 型 mock 会被面板打开前的全文读取调用消费掉）。
let emptyHistory = false;

const invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === "read_resource_text_detail") {
    return { content: TEXT, truncated: false };
  }
  if (cmd === "get_resource_annotations") return [];
  if (cmd === "list_resource_text_versions") {
    expect(args?.recordId).toBe(record.id);
    return emptyHistory ? [] : VERSIONS;
  }
  if (cmd === "get_resource_text_version_content") {
    return "入库时的旧内容";
  }
  if (cmd === "restore_resource_text_version") {
    expect(args?.versionId).toBe("rtv-1");
    return { content: "/lib/audio_log.txt", record_type: "file" };
  }
  if (cmd === "clear_resource_text_versions") return 2;
  if (cmd === "write_resource_text_content") {
    expect(args?.id).toBe(record.id);
    return { content: record.content, record_type: "file" };
  }
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

function renderDetail(
  onRecordUpdated = () => {},
  recordOverride: Partial<ClipboardRecord> = {},
) {
  return render(
    <ResourceDetailPage
      record={{ ...record, ...recordOverride }}
      typeLabel={() => "文本"}
      onBack={() => {}}
      onDelete={() => {}}
      onRecordUpdated={onRecordUpdated}
    />,
  );
}

async function openHistory(container: HTMLElement) {
  const trigger = await waitFor(() => {
    const buttons = Array.from(container.querySelectorAll("button"));
    const target = buttons.find((button) => button.textContent?.includes("改动记录"));
    if (!target) throw new Error("改动记录按钮未渲染");
    return target;
  });
  trigger.click();
  await waitFor(() => {
    expect(container.querySelector(".text-history-pop")).not.toBeNull();
  });
}

describe("资源文本改动记录", () => {
  it("面板列出全部版本，最新一版标记「当前」且不可预览", async () => {
    const { container } = renderDetail();
    await waitFor(() => {
      expect(container.querySelector("[data-chunk-start]")?.textContent).toContain("第二行");
    });
    await openHistory(container);

    const items = container.querySelectorAll(".text-history-item");
    expect(items.length).toBe(2);
    // 最新版本：当前徽标 + 无预览点击。
    expect(items[0].className).toContain("current");
    expect(items[0].textContent).toContain("当前");
    expect(items[0].textContent).toContain("应用内编辑");
    expect(items[1].textContent).toContain("首次入库");
    // 点「当前」：退出预览并收起面板，不拉取快照（当前内容本就在页面）。
    invokeMock.mockClear();
    items[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => {
      expect(container.querySelector(".text-history-pop")).toBeNull();
    });
    expect(
      invokeMock.mock.calls.some(([cmd]) => cmd === "get_resource_text_version_content"),
    ).toBe(false);
  });

  it("点击历史版本进入只读预览，还原写回文件并自动刷新列表", async () => {
    const onRecordUpdated = vi.fn();
    const { container } = renderDetail(onRecordUpdated);
    await waitFor(() => {
      expect(container.querySelector("[data-chunk-start]")?.textContent).toContain("第二行");
    });
    await openHistory(container);

    // 点历史版本 → 只读预览 banner + 快照内容；面板同时自动收起，
    // 不能挡住横幅上的「还原此版本/退出预览」按钮（防回归钉子）。
    const items = container.querySelectorAll(".text-history-item");
    items[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => {
      expect(container.querySelector(".text-history-pop")).toBeNull();
    });
    const banner = await waitFor(() => {
      const el = container.querySelector(".resource-version-banner");
      if (!el) throw new Error("预览提示条未渲染");
      return el;
    });
    expect(banner.textContent).toContain("只读");
    expect(container.textContent).toContain("入库时的旧内容");

    // 还原：命令层收到版本 id，记录归一为文件承载形态。
    const restoreButton = Array.from(banner.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("还原此版本"),
    );
    expect(restoreButton).toBeTruthy();
    restoreButton!.click();
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some(([cmd]) => cmd === "restore_resource_text_version"),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(onRecordUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ id: record.id, type: "file" }),
      );
    });
    // 还原完成：预览退出、反馈 toast 出现、列表刷新（第二次 list 调用）。
    await waitFor(() => {
      expect(container.querySelector(".resource-history-toast")).not.toBeNull();
    });
    expect(container.querySelector(".resource-version-banner")).toBeNull();
    const listCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "list_resource_text_versions");
    expect(listCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("无改动记录时展示空态", async () => {
    emptyHistory = true;
    const { container } = renderDetail();
    await waitFor(() => {
      expect(container.querySelector("[data-chunk-start]")).not.toBeNull();
    });
    await openHistory(container);
    await waitFor(() => {
      expect(container.querySelector(".text-history-empty")?.textContent).toContain("尚无改动记录");
    });
  });

  // 预览历史版本后必须能从列表一键回到最新：点「当前」= 退出预览 + 收起
  // 面板，不用先收面板再去找横幅上的「退出预览」（防回归钉子）。
  it("预览历史版本后点「当前」回到最新内容", async () => {
    const { container } = renderDetail();
    await waitFor(() => {
      expect(container.querySelector("[data-chunk-start]")?.textContent).toContain("第二行");
    });
    await openHistory(container);
    let items = await waitFor(() => {
      const els = container.querySelectorAll(".text-history-item");
      expect(els.length).toBe(2);
      return els;
    });
    items[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => {
      expect(container.querySelector(".resource-version-banner")).not.toBeNull();
    });

    invokeMock.mockClear();
    await openHistory(container);
    items = await waitFor(() => {
      const els = container.querySelectorAll(".text-history-item");
      expect(els.length).toBe(2);
      return els;
    });
    expect(items[0].textContent).toContain("当前");
    items[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => {
      expect(container.querySelector(".resource-version-banner")).toBeNull();
    });
    expect(container.querySelector(".text-history-pop")).toBeNull();
    expect(container.textContent).toContain("第二行");
    expect(
      invokeMock.mock.calls.some(([cmd]) => cmd === "get_resource_text_version_content"),
    ).toBe(false);
  });

  // 详情页顶栏的「打开所在位置」入口：点击后携带文件路径发起 reveal
  // 命令（防回归钉子——入口被误删或路径传错时在此暴露）。
  it("详情页提供「打开所在位置」入口并携带文件路径", async () => {
    const { container } = renderDetail();
    await waitFor(() => {
      expect(container.querySelector("[data-chunk-start]")).not.toBeNull();
    });
    const button = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("打开所在位置"),
    );
    expect(button).toBeTruthy();
    invokeMock.mockClear();
    button!.click();
    await waitFor(() => {
      const call = invokeMock.mock.calls.find(([cmd]) => cmd === "reveal_resource_file");
      if (!call) throw new Error("reveal 命令未发出");
      expect(call[1]?.path).toBe(record.resource_path);
    });
  });

  it("按 Esc 关闭面板", async () => {
    const { container } = renderDetail();
    await waitFor(() => {
      expect(container.querySelector("[data-chunk-start]")?.textContent).toContain("第二行");
    });
    await openHistory(container);
    const anchor = container.querySelector(".text-history-anchor");
    expect(anchor).not.toBeNull();
    anchor!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => {
      expect(container.querySelector(".text-history-pop")).toBeNull();
    });
  });

  // 外部发现的记录（resource_managed=false）保存时也必须传 id：改动记录
  // 按 record_id 记版，漏传 id 会让外部资源的历史面板永远为空（防回归钉子）。
  it("外部记录（resource_managed=false）保存仍传 id", async () => {
    const onRecordUpdated = vi.fn();
    const { container } = renderDetail(onRecordUpdated, { resource_managed: false });
    await waitFor(() => {
      expect(container.querySelector("[data-chunk-start]")?.textContent).toContain("第二行");
    });
    const editButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("编辑内容"),
    );
    expect(editButton).toBeTruthy();
    editButton!.click();
    const editor = await waitFor(() => {
      const el = container.querySelector<HTMLTextAreaElement>("textarea.resource-detail-text-editor");
      if (!el) throw new Error("编辑器未渲染");
      return el;
    });
    fireEvent.change(editor, { target: { value: `${TEXT}外部资源新增的一行。\n` } });
    const saveButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("保存修改"),
    );
    expect(saveButton).toBeTruthy();
    saveButton!.click();
    const saveCall = await waitFor(() => {
      const call = invokeMock.mock.calls.find(([cmd]) => cmd === "write_resource_text_content");
      if (!call) throw new Error("保存命令未发出");
      return call;
    });
    expect(saveCall[1]?.id).toBe(record.id);
    expect(saveCall[1]?.path).toBe(record.resource_path);
    await waitFor(() => {
      expect(onRecordUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ id: record.id, type: "file" }),
      );
    });
  });
});
