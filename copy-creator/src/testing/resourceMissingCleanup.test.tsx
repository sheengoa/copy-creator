// @vitest-environment jsdom
// 回归钉子：点击「清理全部缺失」整页消失（用户实测）。挂载完整资源页，
// 走 缺失筛选 → 清理全部缺失 → 复查 → 确认删除 全链路，任何一步渲染
// 抛错都会让 React 卸载整树，测试即刻暴露。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

afterEach(cleanup);

const missingRecord = {
  id: "resource-file:/lib/gone.mp4",
  type: "file",
  content: "/lib/gone.mp4",
  source_app: "",
  created_at: "2026-10-14T08:00:00Z",
  storage_mode: "resource",
  resource_path: "/lib/gone.mp4",
  resource_missing: true,
};

let recheckCalls = 0;
const invokeMock = vi.fn(async (cmd: string) => {
  switch (cmd) {
    case "get_clipboard_records":
      return [missingRecord];
    case "get_resource_groups":
      return [];
    case "trash_items_count":
      return 0;
    case "get_resource_library_path":
      return "/lib";
    case "get_resource_library_revision":
      return 1;
    case "get_all_settings":
      return {};
    case "recheck_missing_resources":
      // 与后端 serde 命名一致：snake_case 由 Tauri 转驼峰后送达。
      recheckCalls += 1;
      return {
        libraryAccessible: true,
        recovered: 0,
        totalResources: 1,
        stillMissing: [{ id: missingRecord.id, name: "gone.mp4" }],
      };
    case "delete_clipboard_records":
      return { deleted: 1, filesAlreadyMissing: 1 };
    default:
      return null;
  }
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => invokeMock(cmd),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import "../i18n";
import ResourcePage from "../pages/ResourcePage";

// jsdom 没有 IntersectionObserver（视频海报懒加载用到）；真实 WebView 存在。
class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);

// jsdom 没有 ResizeObserver（瀑布流列数随宽度重算用到）。
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

describe("资源缺失清理链路", () => {
  it("缺失筛选 → 清理全部缺失 → 复查清单 → 确认删除，全程不整页崩溃", async () => {
    const { container, getByRole } = render(<ResourcePage />);

    // 缺失 chip 出现并进入缺失视图
    const chip = await waitFor(() => {
      const el = getByRole("button", { name: /缺失 1/ });
      expect(el).toBeTruthy();
      return el;
    });
    fireEvent.click(chip);

    // 操作条出现，点击「清理全部缺失」
    const cleanButton = await waitFor(() => {
      const el = getByRole("button", { name: /清理全部缺失/ });
      expect(el).toBeTruthy();
      return el;
    });
    fireEvent.click(cleanButton);

    // 复查后确认对话框渲染出文件清单（页面未消失 = 组件树存活）
    const dialogTitle = await waitFor(() => getByRole("heading", { name: "清理缺失记录" }));
    expect(dialogTitle).toBeTruthy();
    expect(recheckCalls).toBe(1);
    await waitFor(() => {
      expect(container.textContent).toContain("gone.mp4");
    });

    // 确认删除走既有删除通道（进回收站）
    fireEvent.click(getByRole("button", { name: /删除 1 条/ }));
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some(([cmd]) => cmd === "delete_clipboard_records"),
      ).toBe(true);
    });
    // 页面仍然存活（对话框已关闭、列表仍在）
    await waitFor(() => {
      expect(container.querySelector(".dialog-overlay")).toBeNull();
    });
    expect(container.querySelector(".resource-library-page")).toBeTruthy();
  });
});

// 字段命名错位回归钉子：后端序列化命名一旦偏离（如漏声明 camelCase
// rename，真实事故），对话框必须降级为空清单/离线面板，而不是渲染抛错
// 卸载整棵组件树（用户实测「一点清理整页消失」）。
describe("清理对话框字段容错", () => {
  it("收到 snake_case 载荷（字段全缺）时降级渲染，不整页崩溃", async () => {
    const { default: ResourceCleanupDialog } = await import("../pages/ResourcePage/ResourceCleanupDialog");
    const badPayload = {
      // 模拟漏改名的后端：字段仍是蛇形
      library_accessible: true,
      recovered: 0,
      total_resources: 43,
      still_missing: [{ id: "m1", name: "gone.mp4" }],
    } as never;
    const { container } = render(
      <ResourceCleanupDialog
        open
        checking={false}
        check={badPayload}
        cleaning={false}
        libraryPath="/lib"
        onClose={() => {}}
        onConfirm={() => {}}
        onRecheck={() => {}}
        onOpenLibrarySettings={() => {}}
      />,
    );
    // 不抛错即存活；libraryAccessible !== true 走离线拒绝面板（安全侧）
    expect(container.querySelector(".dialog-overlay")).toBeTruthy();
    expect(container.textContent).toContain("资源库目录当前无法访问");
    // 绝不渲染破坏性确认按钮
    expect(container.textContent).not.toContain("删除");
  });
});
