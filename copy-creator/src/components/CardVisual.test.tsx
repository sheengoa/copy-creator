// @vitest-environment jsdom
// 守护测试：三页共用卡片预览分支（CardVisual）。卡片化后剪切板/快捷
// 输入/资源三页的预览区都经本组件按 kind 分支渲染，分支回归（如图片
// 走原图、视频丢播放角标）在此钉死。
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardVisual, type CardVisualData } from "./CardVisual";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(""),
}));

// jsdom 无 IntersectionObserver：缩略图懒加载与视频封面帧的进视口
// 触发统一打桩为「永不进视口」，组件落空态分支（占位/loading）。
class MockIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);

afterEach(cleanup);

const base: CardVisualData = {
  kind: "text",
  recordType: "text",
  title: "标题",
  summary: "摘要正文",
  content: "/tmp/x",
  textPreviewPath: null,
  resourcePath: null,
  mediaVersion: null,
  createdAt: "2026-01-01T00:00:00Z",
};

const typeLabel = (kind: string) => ({ text: "文本", image: "图片", video: "视频", audio: "音频", file: "文件" }[kind] ?? kind);

describe("CardVisual 分支", () => {
  it("纯文本走摘要预览（resource-card-text-preview）", () => {
    const { container } = render(<CardVisual view={base} search="" typeLabel={typeLabel} />);
    const box = container.querySelector(".resource-card-text-preview");
    expect(box).not.toBeNull();
    expect(box?.textContent).toContain("摘要正文");
  });

  it("链接文本加 is-link 修饰（accent 色）", () => {
    const { container } = render(
      <CardVisual view={{ ...base, recordType: "link" }} search="" typeLabel={typeLabel} />,
    );
    expect(container.querySelector(".resource-card-text-preview.is-link")).not.toBeNull();
  });

  it("文本文件走 textPreviewPath 判定字段（守卫规则 19）", async () => {
    const { container } = render(
      <CardVisual view={{ ...base, textPreviewPath: "/tmp/notes.md" }} search="" typeLabel={typeLabel} />,
    );
    await waitFor(() => {
      expect(container.querySelector(".inline-text-file-preview")).not.toBeNull();
    });
  });

  it("图片走 256px 缩略图管线（ResourceFileImage）并携带版本", () => {
    const { container } = render(
      <CardVisual
        view={{ ...base, kind: "image", content: "/tmp/a.png", resourcePath: "/lib/a.png", mediaVersion: "1720000000000" }}
        search=""
        typeLabel={typeLabel}
      />,
    );
    // 缩略图组件经 inView 懒加载，jsdom 不进视口 → 挂载 loading 占位
    // （类名含 resource-card-file-image），锁定「已挂载缩略图管线」契约。
    expect(container.querySelector(".resource-card-file-image")).not.toBeNull();
  });

  it("视频走封面帧 + 播放角标，音频/普通文件走占位视觉", () => {
    const video = render(
      <CardVisual view={{ ...base, kind: "video", resourcePath: "/lib/v.mp4" }} search="" typeLabel={typeLabel} />,
    );
    expect(video.container.querySelector(".resource-card-video")).not.toBeNull();
    expect(video.container.querySelector(".resource-card-play")).not.toBeNull();
    video.unmount();
    cleanup();

    const audio = render(
      <CardVisual view={{ ...base, kind: "audio" }} search="" typeLabel={typeLabel} />,
    );
    expect(audio.container.querySelector(".resource-card-audio")).not.toBeNull();
    expect(audio.container.textContent).toContain("音频");
    audio.unmount();
    cleanup();

    const file = render(<CardVisual view={{ ...base, kind: "file" }} search="" typeLabel={typeLabel} />);
    expect(file.container.querySelector(".resource-card-file")).not.toBeNull();
    expect(file.container.textContent).toContain("文件");
  });
});
