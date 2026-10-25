// @vitest-environment jsdom
// 挂靠选择器回归钉子：后端搜索分页（500/页 + 显示更多）、防抖搜索、
// 挂靠成功回调 onLinked（「重新挂靠替换」挂新撤旧依赖它）、已挂靠文件
// 不可再点。曾在实机暴露「硬编码 200 条、大库后半选不到」的缺陷。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

afterEach(cleanup);

const PAGE = 500;
let allRecords: Array<Record<string, unknown>>;

const invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  switch (cmd) {
    case "get_resource_library_path":
      return "/lib";
    case "get_clipboard_records": {
      const offset = Number(args?.offset ?? 0);
      const limit = Number(args?.limit ?? 200);
      const search = typeof args?.search === "string" ? args.search.trim().toLowerCase() : "";
      const matched = search
        ? allRecords.filter((record) => String(record.resource_path).toLowerCase().includes(search))
        : allRecords;
      return matched.slice(offset, offset + limit);
    }
    case "project_link_asset":
      return { id: "a9", file_path: args?.filePath, missing: false };
    case "project_list_shows":
      return [];
    default:
      return null;
  }
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

import "../i18n";
import { useProjectStore } from "../stores/projectStore";
import ProjectAssetPicker from "../pages/ResourcePage/ProjectAssetPicker";

function makeRecords(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `r${index}`,
    type: "file",
    content: `/lib/组A/文件${index}.png`,
    resource_path: `/lib/组A/文件${index}.png`,
    storage_mode: "resource",
  }));
}

function seedStore(overviewLoosePaths: string[] = []) {
  useProjectStore.setState({
    view: "project",
    currentEpisodeId: "ep1",
    overview: {
      episode: { id: "ep1" },
      loose_assets: overviewLoosePaths.map((filePath, index) => ({
        id: `loose${index}`,
        file_path: filePath,
      })),
      scenes: [],
    } as unknown as never,
  });
}

describe("ProjectAssetPicker", () => {
  it("首页 500 条、显示更多追加下一页", async () => {
    allRecords = makeRecords(530);
    seedStore();
    render(<ProjectAssetPicker shotId="" onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText("500")).toBeTruthy();
    });
    const searchCall = invokeMock.mock.calls.find(([cmd]) => cmd === "get_clipboard_records");
    expect(searchCall?.[1]).toMatchObject({ limit: PAGE, offset: 0 });
    fireEvent.click(screen.getByText("显示更多"));
    await waitFor(() => {
      expect(screen.getByText("530")).toBeTruthy();
    });
    // 追加页走 offset 推进，且不再出现「显示更多」（末页 30 < 500）
    expect(invokeMock.mock.calls.some(([, args]) => args?.offset === PAGE)).toBe(true);
    expect(screen.queryByText("显示更多")).toBeNull();
  });

  it("搜索防抖后走后端并重置分页", async () => {
    allRecords = [
      ...makeRecords(3),
      { id: "rx", type: "file", content: "/lib/组A/补位目标.png", resource_path: "/lib/组A/补位目标.png", storage_mode: "resource" },
    ];
    seedStore();
    render(<ProjectAssetPicker shotId="" onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText("4")).toBeTruthy();
    });
    const input = screen.getByPlaceholderText("搜索文件名…") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "补位" } });
    await waitFor(() => {
      expect(screen.getByText("1")).toBeTruthy();
    });
    const searched = invokeMock.mock.calls.filter(([cmd, args]) => cmd === "get_clipboard_records" && args?.search === "补位");
    expect(searched.length).toBeGreaterThan(0);
    expect(searched[0][1]).toMatchObject({ offset: 0, limit: PAGE });
    expect(screen.getByText("补位目标.png")).toBeTruthy();
  });

  it("点选挂靠成功后调用 onLinked；已挂靠文件不可再点", async () => {
    allRecords = makeRecords(2);
    // 组A/文件0.png 已挂靠（在 overview 散件里）
    seedStore(["组A/文件0.png"]);
    const onLinked = vi.fn();
    const onClose = vi.fn();
    render(<ProjectAssetPicker shotId="sh1" onClose={onClose} onLinked={onLinked} />);
    await waitFor(() => {
      expect(screen.getByText("文件0.png")).toBeTruthy();
    });
    // 已挂靠卡片无 pick 类：点它不触发挂靠
    const linkedCard = screen.getByText("文件0.png").closest(".project-library-card")!;
    expect(linkedCard.className).not.toContain("pick");
    fireEvent.click(linkedCard);
    expect(onLinked).not.toHaveBeenCalled();
    // 未挂靠卡片：点它走 linkAsset → onLinked → onClose
    const freeCard = screen.getByText("文件1.png").closest(".project-library-card")!;
    expect(freeCard.className).toContain("pick");
    fireEvent.click(freeCard);
    await waitFor(() => {
      expect(onLinked).toHaveBeenCalledTimes(1);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    const linkCall = invokeMock.mock.calls.find(([cmd]) => cmd === "project_link_asset");
    expect(linkCall?.[1]).toMatchObject({
      filePath: "组A/文件1.png",
      episodeId: "ep1",
      shotId: "sh1",
    });
  });
});
