// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../i18n";
import { type CanvasNode } from "../../../stores/canvasStore";
import { FrameExtractBody } from "./FrameExtractBody";
import { useNodeErrors } from "./nodeErrors";
import { VideoToolRuntimeProvider } from "./VideoToolRuntimeProvider";
import type { NodeProps } from "./types";
import type { VideoToolRuntime } from "./videoToolRuntimeCtx";

// 首帧/尾帧清除×三态守卫（2026-11-07 用户反馈）：已加载未执行/执行失败
// 也必须能叉掉换片（此前×只在执行成功有产物时渲染，未执行/失败态无从
// 换片，只能删节点重来）；执行中不显示（与工具三节点同语义，用户定案）。

const makeNode = (overrides: Partial<CanvasNode> = {}): CanvasNode => ({
  id: "vf1",
  canvas_id: "c1",
  type: "video_last_frame",
  title: "",
  pos_x: 0,
  pos_y: 0,
  width: null,
  height: null,
  metadata: { kind: "video_last_frame", video_path: "videos/a.mp4" },
  resource_path: "",
  created_at: "",
  updated_at: "",
  ...overrides,
});

const makeRuntime = (overrides: Partial<VideoToolRuntime> = {}): VideoToolRuntime => ({
  videoTimelines: {},
  videoToolDraft: {},
  setVideoToolDraft: vi.fn(),
  registerVideoEl: vi.fn(),
  getVideoEl: vi.fn(() => null),
  frameBusy: {},
  seekToolTo: vi.fn(),
  rangeToolTo: vi.fn(),
  commitVideoTool: vi.fn(),
  runVideoTool: vi.fn(async () => {}),
  runFrameExtract: vi.fn(async () => {}),
  clearFrameVideo: vi.fn(),
  resetToolSession: vi.fn(),
  ...overrides,
});

const services = {
  pickMedia: vi.fn(),
  clearMedia: vi.fn(),
  upstream: vi.fn(() => null),
  locateNode: vi.fn(),
} as unknown as NodeProps["services"];

const renderBody = (node: CanvasNode, runtime = makeRuntime()) =>
  render(
    <VideoToolRuntimeProvider runtime={runtime}>
      <FrameExtractBody node={node} selected={false} pulsing={false} autoHeight={false} scale={1} services={services} />
    </VideoToolRuntimeProvider>,
  );

const findClear = () =>
  screen.queryByRole("button", { name: "移除已加载文件" });

afterEach(() => {
  cleanup();
  useNodeErrors.setState({ errors: {} });
});

describe("FrameExtractBody 清除×状态覆盖", () => {
  it("已加载未执行：×存在，点击调 clearFrameVideo", () => {
    const runtime = makeRuntime();
    renderBody(makeNode(), runtime);
    const clear = findClear();
    expect(clear).not.toBeNull();
    fireEvent.click(clear!);
    expect(runtime.clearFrameVideo).toHaveBeenCalledTimes(1);
  });

  it("执行失败（有错误文案无产物）：×仍存在可换片", () => {
    useNodeErrors.setState({ errors: { vf1: "提取失败：无视频轨" } });
    const runtime = makeRuntime();
    renderBody(makeNode(), runtime);
    expect(findClear()).not.toBeNull();
    expect(screen.getByText("提取失败：无视频轨")).not.toBeNull();
  });

  it("执行完成（有产物）：×存在（原语义保持）", () => {
    const runtime = makeRuntime();
    renderBody(
      makeNode({ resource_path: "frames/last.png" }),
      runtime,
    );
    expect(findClear()).not.toBeNull();
    expect(screen.getByText("尾帧")).not.toBeNull();
  });

  it("执行中：×不显示（用户定案，与工具三节点同语义）", () => {
    renderBody(makeNode(), makeRuntime({ frameBusy: { vf1: true } }));
    expect(findClear()).toBeNull();
  });

  it("未加载视频（空态）：无×，入口按钮可见", () => {
    renderBody(
      makeNode({ metadata: { kind: "video_last_frame", video_path: "" } }),
    );
    expect(findClear()).toBeNull();
    expect(screen.getByRole("button", { name: "资源库" })).not.toBeNull();
  });
});
