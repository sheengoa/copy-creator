// @vitest-environment jsdom
// 守护测试：快捷输入卡片形态（卡片化定案 2026-11-14）。点击 = 查看内容、
// 平铺网格渲染、全部视图分组标签、「⋯」菜单含移到顶部；排序把手仍在
// meta 行（dnd-kit 激活器）。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { PhraseList } from "./PhraseList";
import type { Phrase } from "../../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(""),
}));

// jsdom 无 IntersectionObserver：打桩为「永不进视口」，媒体组件落
// 占位分支（真实行为由浏览器 mock 实测承担）。
class MockIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);

// jsdom 无 ResizeObserver：紧凑条截断渐隐检测（useIsClamped）打桩为
// 永不回调（真实行为由浏览器 mock 实测承担）。
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
vi.stubGlobal("ResizeObserver", MockResizeObserver);

afterEach(cleanup);

function phrase(overrides: Partial<Phrase> = {}): Phrase {
  return {
    id: "ph-1",
    group_id: "pg-1",
    title: "开场白",
    content: "您好，这条话术用于卡片文本预览。",
    input_type: "text",
    source_path: "",
    file_size: 0,
    sort_order: 0,
    created_at: "2026-11-14T10:00:00Z",
    updated_at: "2026-11-14T10:00:00Z",
    ...overrides,
  };
}

const listProps = () => ({
  loading: false,
  loadedOnce: true,
  selectedGroupId: "pg-1",
  search: "",
  columnCount: 2,
  scrollRef: undefined,
  onOpenView: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onMoveToTop: vi.fn(),
  showGroupTag: false,
  getKindLabel: (kind: string) => ({ text: "文本", image: "图片", video: "视频", audio: "音频", file: "文件" }[kind] ?? kind),
  selectionMode: false,
  isSelected: () => false,
  onToggleSelected: vi.fn(),
  navDisabled: false,
});

describe("PhraseList 卡片形态", () => {
  it("渲染分列瀑布流：文本短语紧凑条 + meta", () => {
    const props = listProps();
    const { container } = render(<PhraseList phrases={[phrase()]} {...props} />);
    const card = container.querySelector("article.resource-card.phrase-card.card-slim");
    expect(card).not.toBeNull();
    expect(container.querySelector(".resource-columns")?.getAttribute("style")).toContain("repeat(2");
    expect(container.querySelector(".resource-column")).not.toBeNull();
    expect(container.querySelector(".card-slim-topline")?.textContent).toContain("文本");
    expect(container.querySelector(".card-slim-content")?.textContent).toContain("这条话术用于卡片文本预览");
    expect(container.querySelector(".resource-card-meta")?.textContent).toContain("文本");
  });

  it("点击卡片 = 查看内容（不触发粘贴）", () => {
    const props = listProps();
    const { container } = render(<PhraseList phrases={[phrase()]} {...props} />);
    fireEvent.click(container.querySelector("article")!);
    expect(props.onOpenView).toHaveBeenCalledWith(expect.objectContaining({ id: "ph-1" }));
  });

  it("全部视图显示分组标签；菜单含移到顶部且不含粘贴项", () => {
    const props = listProps();
    const { container } = render(
      <PhraseList phrases={[phrase({ group_name: "日常话术" })]} {...props} showGroupTag />,
    );
    expect(container.querySelector(".phrase-card-group-tag")?.textContent).toBe("日常话术");
    fireEvent.click(container.querySelector(".resource-card-more-button")!);
    expect(screen.getByText("移到顶部")).not.toBeNull();
    expect(screen.queryByText("粘贴到光标位置")).toBeNull();
    fireEvent.click(screen.getByText("删除"));
    expect(props.onDelete).toHaveBeenCalledWith("ph-1");
  });

  it("排序把手保留在 meta 行（拖拽激活器）", () => {
    const props = listProps();
    const { container } = render(<PhraseList phrases={[phrase()]} {...props} />);
    expect(container.querySelector(".resource-card-meta .drag-handle")).not.toBeNull();
  });

  it("首屏加载亮骨架网格（resource-list-skeleton）", () => {
    const props = { ...listProps(), loading: true, loadedOnce: false };
    const { container } = render(<PhraseList phrases={[]} {...props} />);
    expect(container.querySelector(".resource-list-skeleton")).not.toBeNull();
    expect(container.querySelectorAll(".resource-card-skeleton").length).toBeGreaterThan(0);
  });
});


