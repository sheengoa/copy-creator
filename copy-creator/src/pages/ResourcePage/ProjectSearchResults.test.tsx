// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { useProjectStore, type ProjectSearchItem } from "../../stores/projectStore";
import ProjectSearchResults from "./ProjectSearchResults";

// 工程视图搜索结果的命中高亮（2026-11-14 用户报告「搜索点亮没了」的
// 工程视图补齐）：标题与提示词正文走 HighlightText，命中段包
// mark.search-highlight——样式由 components.css 主题自适应规则统一承担。
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]) }));

afterEach(() => {
  cleanup();
  useProjectStore.setState({ searchResults: [], searchLoading: false });
});

function seedResults(items: ProjectSearchItem[]) {
  useProjectStore.setState({ searchResults: items, searchLoading: false });
}

describe("ProjectSearchResults 命中高亮", () => {
  it("标题命中段渲染 mark.search-highlight", () => {
    seedResults([{ kind: "show", id: "s1", title: "星尘档案" }]);
    render(<ProjectSearchResults search="星尘" onJumped={() => {}} />);
    const mark = screen.getByText("星尘").closest("mark");
    expect(mark).not.toBeNull();
    expect(mark?.className).toBe("search-highlight");
    // 命中段之外的文本保持在 mark 外
    expect(mark?.parentElement?.textContent).toBe("星尘档案");
  });

  it("搜索词为空时标题原样渲染（不包 mark）", () => {
    seedResults([{ kind: "show", id: "s1", title: "星尘档案" }]);
    render(<ProjectSearchResults search="" onJumped={() => {}} />);
    expect(document.querySelector("mark.search-highlight")).toBeNull();
    expect(screen.getByText("星尘档案")).not.toBeNull();
  });

  it("提示词条目的正文命中段同样高亮", () => {
    seedResults([{ kind: "prompt", id: "p1", title: "雨夜开场", content: "霓虹街道的雨夜全景" }]);
    render(<ProjectSearchResults search="雨夜" onJumped={() => {}} />);
    const marks = Array.from(document.querySelectorAll("mark.search-highlight"));
    expect(marks.map((m) => m.textContent)).toEqual(["雨夜", "雨夜"]);
  });
});
