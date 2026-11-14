// @vitest-environment jsdom
// 守护测试：剪切板卡片形态（卡片化定案 2026-11-14）。点击 = 打开详情视图
// （复用资源库详情页）、操作收敛进「⋯」菜单与右键菜单、多选态点击切换
// 选中；详情页正文编辑走页内编辑态（无弹窗），粘贴只在径向菜单。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { ClipboardCard } from "./ClipboardCard";
import ResourceDetailPage from "../ResourcePage/ResourceDetailPage";
import { buildRecordView } from "../../domain/recordView";
import type { ClipboardRecord } from "../../types";

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

function textRecord(overrides: Partial<ClipboardRecord> = {}): ClipboardRecord {
  return {
    id: "rec-1",
    type: "text",
    content: "第一条剪切板记录的正文内容",
    source_app: "tester",
    created_at: "2026-11-14T10:00:00Z",
    ...overrides,
  };
}

const baseProps = () => {
  const view = buildRecordView(textRecord());
  return {
    view,
    getTypeLabel: (type: string) => ({ text: "文本", image: "图片", link: "链接", file: "文件" }[type] ?? type),
    getKindLabel: (kind: string) => ({ text: "文本", image: "图片", video: "视频", audio: "音频", file: "文件" }[kind] ?? kind),
    pasteLeftClick: "normal" as const,
    search: "",
    onOpenView: vi.fn(),
    onPasteNormal: vi.fn(),
    onPasteTerminal: vi.fn(),
    onDelete: vi.fn(),
    getRecordContent: vi.fn().mockResolvedValue("正文"),
    onToggleUserApiKey: vi.fn(),
    selectionMode: false,
    selected: false,
    onToggleSelected: vi.fn(),
  };
};

describe("ClipboardCard 卡片形态", () => {
  it("文本记录渲染紧凑条：topline + 正文直排 + meta（无 16:10 预览框）", () => {
    const props = baseProps();
    const { container } = render(<ClipboardCard {...props} />);
    const card = container.querySelector("article.resource-card.clipboard-card.card-slim.type-text");
    expect(card).not.toBeNull();
    // 紧凑条无预览大框：正文直排 + topline 类型 + meta。
    expect(container.querySelector(".resource-card-preview")).toBeNull();
    expect(container.querySelector(".card-slim-topline")?.textContent).toContain("文本");
    expect(container.querySelector(".card-slim-content")?.textContent).toContain("第一条剪切板记录的正文内容");
    expect(container.querySelector(".resource-card-meta")?.textContent).toContain("文本");
    // 操作不再有 hover 按钮组（规则 18）：卡片根无 card-*-btn。
    expect(container.querySelectorAll("[class*='card-'][class*='-btn']").length).toBe(0);
  });

  it("媒体记录渲染矮横幅卡：preview 区保留 + 类型角标", () => {
    const props = baseProps();
    const imageRecord = textRecord({ id: "rec-img", type: "image", content: "/tmp/a.png" });
    const imageView = buildRecordView(imageRecord);
    const { container } = render(<ClipboardCard {...props} view={imageView} />);
    const card = container.querySelector("article.resource-card.card-media");
    expect(card).not.toBeNull();
    expect(container.querySelector(".resource-card-preview")).not.toBeNull();
    expect(container.querySelector(".resource-card-kind")?.textContent).toBe("图片");
  });

  it("点击卡片 = 查看内容（不触发粘贴）", () => {
    const props = baseProps();
    const { container } = render(<ClipboardCard {...props} />);
    fireEvent.click(container.querySelector("article")!);
    expect(props.onOpenView).toHaveBeenCalledWith(props.view);
    expect(props.onPasteNormal).not.toHaveBeenCalled();
  });

  it("多选态点击切换选中；Enter/Space 同单击语义", () => {
    const props = baseProps();
    const { container } = render(
      <ClipboardCard {...props} selectionMode selected={false} />,
    );
    fireEvent.click(container.querySelector("article")!);
    expect(props.onToggleSelected).toHaveBeenCalledWith("rec-1");
    expect(props.onOpenView).not.toHaveBeenCalled();

    const props2 = baseProps();
    const { container: c2 } = render(<ClipboardCard {...props2} />);
    fireEvent.keyDown(c2.querySelector("article")!, { key: "Enter" });
    expect(props2.onOpenView).toHaveBeenCalledWith(props2.view);
  });

  it("「⋯」菜单收编操作且不含粘贴/编辑（编辑在详情页内联，粘贴只在径向菜单）", () => {
    const props = { ...baseProps(), onSetPinned: vi.fn() };
    const { container } = render(<ClipboardCard {...props} />);
    fireEvent.click(container.querySelector(".resource-card-more-button")!);
    // 菜单 portal 到 body。
    expect(screen.getByText("收藏")).not.toBeNull();
    expect(screen.queryByText("粘贴到光标位置")).toBeNull();
    expect(screen.queryByText("粘贴到终端")).toBeNull();
    expect(screen.queryByText("编辑内容")).toBeNull();
    fireEvent.click(screen.getByText("删除"));
    expect(props.onDelete).toHaveBeenCalledWith("rec-1");
    expect(props.onOpenView).not.toHaveBeenCalled();
  });

  it("右键弹出同一组菜单（右键不再直接粘贴）", () => {
    const props = { ...baseProps(), onSetPinned: vi.fn() };
    const { container } = render(<ClipboardCard {...props} />);
    fireEvent.contextMenu(container.querySelector("article")!);
    expect(screen.getByText("收藏")).not.toBeNull();
    expect(screen.queryByText("粘贴到光标位置")).toBeNull();
  });

  it("搜索命中段在紧凑条正文高亮", () => {
    const props = baseProps();
    const { container } = render(<ClipboardCard {...props} search="正文" />);
    expect(container.querySelector("mark.search-highlight")).not.toBeNull();
  });
});

describe("ResourceDetailPage 主窗口复用形态", () => {
  it("database 文本记录以详情视图渲染：返回列表 + 删除，无备注/重命名/版本历史", async () => {
    const record = textRecord({ source_app: "Chrome" });
    const onBack = vi.fn();
    const onDelete = vi.fn();
    const onSaveContent = vi.fn().mockResolvedValue(undefined);
    const onRecordUpdated = vi.fn();
    render(
      <ResourceDetailPage
        record={record}
        typeLabel={(kind) => ({ text: "文本", image: "图片", video: "视频", audio: "音频", file: "文件" } as Record<string, string>)[kind] ?? kind}
        onBack={onBack}
        onDelete={onDelete}
        onRecordUpdated={onRecordUpdated}
        hideResourceOps
        onSaveContent={onSaveContent}
        backLabel="返回列表"
      />,
    );
    // 返回按钮文案按主窗口语境（非「返回资源库」）。
    expect(screen.getByText("返回列表")).not.toBeNull();
    // record 形态隐藏资源特有件：备注输入、分组 pill、版本历史不存在。
    expect(screen.queryByText("备注")).toBeNull();
    expect(screen.queryByText("所属分组")).toBeNull();
    expect(screen.queryByText("改动记录")).toBeNull();
    // 编辑 = 资源库同交互：正文全文到达后顶栏「编辑内容」进页内编辑态
    // （无弹窗），保存走注入通道并回调 onRecordUpdated。
    fireEvent.click(await screen.findByText("编辑内容"));
    const editor = await screen.findByDisplayValue(/第一条剪切板记录的正文内容/);
    fireEvent.change(editor, { target: { value: "改后的正文" } });
    fireEvent.click(screen.getByText("保存修改"));
    expect(await screen.findByText("内容已保存")).not.toBeNull();
    expect(onSaveContent).toHaveBeenCalledWith(record, "改后的正文");
    expect(onRecordUpdated).toHaveBeenCalledWith(record);
    fireEvent.click(screen.getByText("删除"));
    expect(onDelete).toHaveBeenCalledWith("rec-1");
  });

  it("文件记录在 record 形态只读（无编辑入口），仍可打开所在位置", () => {
    const fileRecord: ClipboardRecord = {
      id: "rec-file-1",
      type: "file",
      content: "/tmp/movie.mp4",
      source_app: "tester",
      created_at: "2026-11-14T10:00:00Z",
    };
    render(
      <ResourceDetailPage
        record={fileRecord}
        typeLabel={(kind) => ({ text: "文本", image: "图片", video: "视频", audio: "音频", file: "文件" } as Record<string, string>)[kind] ?? kind}
        onBack={vi.fn()}
        onDelete={vi.fn()}
        onRecordUpdated={() => {}}
        hideResourceOps
        onSaveContent={vi.fn()}
        backLabel="返回列表"
      />,
    );
    // file 记录编辑目标是文件语义，主窗口保持只读。
    expect(screen.queryByText("编辑内容")).toBeNull();
    expect(screen.getByText("打开所在位置")).not.toBeNull();
  });
});
