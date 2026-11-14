// @vitest-environment jsdom
// 挂靠选择器回归钉子：后端搜索分页（500/页 + 显示更多）、防抖搜索、
// 挂靠成功回调 onLinked（「重新挂靠替换」挂新撤旧依赖它）、已挂靠文件
// 不可再点、分组树过滤（resourceGroup 含子级）与分组内搜索空态的
// 「在全部文件中搜索」兜底。曾在实机暴露「硬编码 200 条、大库后半选
// 不到」的缺陷。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

afterEach(cleanup);

const PAGE = 500;
let allRecords: Array<Record<string, unknown>>;
let pickResultPath = "";
let importCalls: Array<Record<string, unknown>> = [];

const invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  switch (cmd) {
    case "get_resource_library_path":
      return "/lib";
    case "list_resource_groups": {
      // 分组树 mock：与 allRecords 里 /lib/<组>/ 的目录对应，首项固定为
      // 「未分组」空路径根（后端 list_resource_groups 同约定）。
      const topPaths = new Set(
        allRecords
          .map((record) => String(record.resource_path).replace(/^\/lib\//, ""))
          .filter((relative) => relative.includes("/"))
          .map((relative) => relative.split("/")[0]),
      );
      return [
        { name: "", path: "", count: 0, children: [] },
        ...[...topPaths].map((dir) => ({
          name: dir,
          path: dir,
          count: allRecords.filter((record) =>
            String(record.resource_path).startsWith(`/lib/${dir}/`),
          ).length,
          children: [],
        })),
      ];
    }
    case "list_clipboard_records": {
      const offset = Number(args?.offset ?? 0);
      const limit = Number(args?.limit ?? 200);
      const search = typeof args?.search === "string" ? args.search.trim().toLowerCase() : "";
      const matched = search
        ? allRecords.filter((record) => String(record.resource_path).toLowerCase().includes(search))
        : allRecords;
      // 分组过滤与后端同语义：""=库根未分组，路径=该分组含子级。
      const group = typeof args?.resourceGroup === "string" ? args.resourceGroup : null;
      const grouped =
        group === null
          ? matched
          : matched.filter((record) => {
              const parts = String(record.resource_path).replace(/^\/lib\//, "").split("/");
              const dir = parts.slice(0, -1).join("/");
              if (group === "") return dir === "";
              return dir === group || dir.startsWith(`${group}/`);
            });
      return grouped.slice(offset, offset + limit);
    }
    case "project_link_asset":
      return { id: "a9", file_path: args?.filePath, missing: false };
    case "project_list_shows":
      return [];
    // 导入流：pickResultPath 为 "" 时按钮点了也不该走到这；"cancelled"
    // 模拟文件框取消；"ERROR" 模拟导入失败。通用浮层只入库
    // （import_resource_file），挂靠由壳在 onPick 里接手（project_link_asset）。
    case "select_resource_trace_file": {
      if (pickResultPath === "cancelled") throw new Error("cancelled");
      return { path: pickResultPath };
    }
    case "import_resource_file":
      if (pickResultPath === "ERROR") throw new Error("磁盘已满");
      importCalls.push(args ?? {});
      return { file_path: "新素材.png", kind: "image", name: "新素材.png" };
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
    // 头部计数与分组树徽章可能同值，断言一律收敛到头部计数元素
    await waitFor(() => {
      expect(screen.getByText("500", { selector: ".project-library-count" })).toBeTruthy();
    });
    const searchCall = invokeMock.mock.calls.find(([cmd]) => cmd === "list_clipboard_records");
    expect(searchCall?.[1]).toMatchObject({ limit: PAGE, offset: 0 });
    fireEvent.click(screen.getByText("显示更多"));
    await waitFor(() => {
      expect(screen.getByText("530", { selector: ".project-library-count" })).toBeTruthy();
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
      expect(screen.getByText("4", { selector: ".project-library-count" })).toBeTruthy();
    });
    const input = screen.getByPlaceholderText("搜索文件名…") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "补位" } });
    await waitFor(() => {
      expect(screen.getByText("1", { selector: ".project-library-count" })).toBeTruthy();
    });
    const searched = invokeMock.mock.calls.filter(([cmd, args]) => cmd === "list_clipboard_records" && args?.search === "补位");
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

  it("从电脑导入并挂靠：入库后挂靠壳接手并触发 onLinked", async () => {
    allRecords = makeRecords(1);
    pickResultPath = "C:/out/新素材.png";
    importCalls = [];
    seedStore();
    const onLinked = vi.fn();
    const onClose = vi.fn();
    render(<ProjectAssetPicker shotId="sh1" onClose={onClose} onLinked={onLinked} />);
    await waitFor(() => {
      expect(screen.getByText("文件0.png")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("从电脑导入并挂靠…"));
    await waitFor(() => {
      expect(onLinked).toHaveBeenCalledTimes(1);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    // 通用浮层只入库；挂靠（含导入文件）由壳接手。mock 调用跨用例
    // 累积，按导入文件名过滤本用例的挂靠调用。
    expect(importCalls[0]).toMatchObject({ sourcePath: "C:/out/新素材.png" });
    const importLink = invokeMock.mock.calls.find(
      ([cmd, args]) => cmd === "project_link_asset" && args?.filePath === "新素材.png",
    );
    expect(importLink?.[1]).toMatchObject({ episodeId: "ep1", shotId: "sh1" });
  });

  it("导入取消静默：不关浮层不报错", async () => {
    allRecords = makeRecords(1);
    pickResultPath = "cancelled";
    seedStore();
    const onLinked = vi.fn();
    const onClose = vi.fn();
    render(<ProjectAssetPicker shotId="" onClose={onClose} onLinked={onLinked} />);
    await waitFor(() => {
      expect(screen.getByText("文件0.png")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("从电脑导入并挂靠…"));
    await waitFor(() => {
      expect(screen.getByText("从电脑导入并挂靠…")).toBeTruthy();
    });
    expect(onLinked).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText(/导入失败/)).toBeNull();
  });

  it("导入失败展示错误且浮层不关", async () => {
    allRecords = makeRecords(1);
    pickResultPath = "ERROR";
    seedStore();
    const onLinked = vi.fn();
    const onClose = vi.fn();
    render(<ProjectAssetPicker shotId="" onClose={onClose} onLinked={onLinked} />);
    await waitFor(() => {
      expect(screen.getByText("文件0.png")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("从电脑导入并挂靠…"));
    await waitFor(() => {
      expect(screen.getByText(/导入失败/).textContent).toContain("磁盘已满");
    });
    expect(onLinked).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("点分组树后按分组过滤（含子级），请求带 resourceGroup", async () => {
    allRecords = [
      ...makeRecords(2),
      { id: "rb", type: "file", content: "/lib/组B/别的.png", resource_path: "/lib/组B/别的.png", storage_mode: "resource" },
    ];
    seedStore();
    render(<ProjectAssetPicker shotId="" onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText("组A")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("组A"));
    await waitFor(() => {
      expect(screen.queryByText("别的.png")).toBeNull();
    });
    expect(screen.getByText("文件0.png")).toBeTruthy();
    const grouped = invokeMock.mock.calls.filter(
      ([cmd, args]) => cmd === "list_clipboard_records" && args?.resourceGroup === "组A",
    );
    expect(grouped.length).toBeGreaterThan(0);
    // 回到全部文件：不带 resourceGroup 参数（null 即全库）
    fireEvent.click(screen.getByText("全部文件"));
    await waitFor(() => {
      expect(screen.getByText("别的.png")).toBeTruthy();
    });
    expect(
      invokeMock.mock.calls.some(
        ([cmd, args]) => cmd === "list_clipboard_records" && args?.resourceGroup === undefined,
      ),
    ).toBe(true);
  });

  it("分组内搜索无结果时给「在全部文件中搜索」兜底并跳出分组", async () => {
    allRecords = [
      ...makeRecords(1),
      { id: "rb2", type: "file", content: "/lib/组B/目标文件.png", resource_path: "/lib/组B/目标文件.png", storage_mode: "resource" },
    ];
    seedStore();
    render(<ProjectAssetPicker shotId="" onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText("组A")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("组A"));
    await waitFor(() => {
      expect(screen.getByPlaceholderText("在 组A 中搜索…")).toBeTruthy();
    });
    const input = screen.getByPlaceholderText("在 组A 中搜索…") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "目标" } });
    await waitFor(() => {
      expect(screen.getByText("当前分组下没有匹配的文件")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("在全部文件中搜索「目标」"));
    await waitFor(() => {
      expect(screen.getByText("目标文件.png")).toBeTruthy();
    });
    expect(
      invokeMock.mock.calls.some(
        ([cmd, args]) =>
          cmd === "list_clipboard_records" && args?.search === "目标" && args?.resourceGroup === undefined,
      ),
    ).toBe(true);
  });
});
